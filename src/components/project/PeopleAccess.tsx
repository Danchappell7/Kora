/* ============================================================
   KANBO — a project's People & access (0058), in its About tab while
   the workspace has project access on. Who can see it (Whole
   workspace, Members only, Private, each with how many people that
   is), the people on it with their role (Can edit / Can comment /
   Can view; guests comment at most), adding someone, and inviting a
   guest straight onto it. Narrowing asks first, naming who'd lose
   access and their open tasks. Someone who can't manage it reads it.
   The server decides every change (0058's set_project_* functions);
   a refusal is said, and the page reloads.
   ============================================================ */
import { useId, useMemo, useState } from "react";
import { Avatar, Button, Icon } from "../primitives";
import type { Project, ProjectRole, ProjectVisibility, Task } from "../../data/types";
import {
  canManagePeople, canSetVisibility, keepsEdit, mayMakePrivate, memberRole, narrowingLoss, rankFor, roleOf, seesCount, visibilityOf,
  ROLE_LABEL, VISIBILITY_LABEL, type AccessCtx,
} from "../../lib/projectAccess";
import "./peopleAccess.css";

const ORDER: ProjectVisibility[] = ["workspace", "members", "private"];
const narrower = (from: ProjectVisibility, to: ProjectVisibility) => ORDER.indexOf(to) > ORDER.indexOf(from);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;
const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

/** The question asked before a project closes to people who can see it now. */
export function narrowingQuestion(projectName: string, to: ProjectVisibility, loss: { name: string; openTasks: number }[]): string {
  const verb = to === "private" ? "private" : "members only";
  if (!loss.length) return `Make ${projectName} ${verb}?`;
  const [first, ...rest] = loss;
  const who = rest.length ? `${first.name} and ${plural(rest.length, "other")} will lose access.` : `${first.name} will lose access.`;
  const busy = loss.find((l) => l.openTasks > 0);
  const tasks = busy ? ` ${firstName(busy.name)} has ${plural(busy.openTasks, "open task")} here.` : "";
  return `Make ${projectName} ${verb}? ${who}${tasks}`;
}

export interface PeopleAccessProps {
  project: Project;
  ctx: AccessCtx;
  workspaceName: string;
  tasks: Pick<Task, "projectId" | "assigneeId" | "status" | "archivedAt">[];
  /** a person's name (profile first, then their invite) */
  nameOf: (userId: string) => string;
  onSetVisibility: (projectId: string, v: ProjectVisibility) => Promise<boolean>;
  onSetMember: (projectId: string, userId: string, role: ProjectRole) => Promise<boolean>;
  onRemoveMember: (projectId: string, userId: string) => Promise<boolean>;
  /** Team's invite sheet with this project chosen (omit: no Invite a guest) */
  onInviteGuest?: (projectId: string) => void;
  /** the project syncs to Notion (people with access there can see its tasks) */
  notionSynced?: boolean;
}

export function PeopleAccess({ project, ctx, workspaceName, tasks, nameOf, onSetVisibility, onSetMember, onRemoveMember, onInviteGuest, notionSynced }: PeopleAccessProps): JSX.Element {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const wsId = project.workspaceId ?? "";
  const vis = visibilityOf(project);
  const manage = canManagePeople(project, ctx);
  const setVis = canSetVisibility(project, ctx);
  const privateOk = mayMakePrivate(wsId, ctx);
  const [asking, setAsking] = useState<ProjectVisibility | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState("");

  const ownerId = project.ownerId ?? null;
  const onList = useMemo(() => (ctx.members ?? []).filter((m) => m.projectId === project.id && m.userId !== ownerId), [ctx.members, project.id, ownerId]);
  const onIt = new Set([...(ownerId ? [ownerId] : []), ...onList.map((m) => m.userId)]);
  const addable = ctx.wsMembers.filter((m) => m.workspaceId === wsId && m.status === "active" && !!m.userId && !onIt.has(m.userId));
  const guest = (uid: string) => roleOf(ctx, wsId, uid) === "guest";

  const choose = (to: ProjectVisibility) => {
    if (to === vis || busy) return;
    if (narrower(vis, to)) { setAsking(to); return; }
    void run(() => onSetVisibility(project.id, to));
  };
  const run = async (f: () => Promise<boolean>) => {
    setBusy(true);
    try { await f(); } finally { setBusy(false); setAsking(null); }
  };
  const loss = asking ? narrowingLoss(project, asking, ctx, tasks, nameOf) : [];

  const LINES: Record<ProjectVisibility, string> = {
    workspace: `Everyone at ${workspaceName} can see and edit it. Guests see it only if you add them.`,
    members: `Only the people below, plus ${workspaceName}'s owners and admins.`,
    private: `Only the people below, plus ${workspaceName}'s owner.`,
  };

  return (
    <section className="kpax" aria-labelledby={`${id}-t`}>
      <h2 id={`${id}-t`} className="kpax-title">People &amp; access</h2>

      <fieldset className="kpax-group" disabled={!setVis || busy}>
        <legend className="kpax-legend">Who can see it</legend>
        {ORDER.map((v) => {
          const off = v === "private" && vis !== "private" && !privateOk;
          const locked = !keepsEdit(project, v, ctx);
          const n = seesCount(project, ctx, v);
          return (
            <label key={v} className="kpax-option" data-chosen={v === vis || undefined} data-off={off || locked || undefined}>
              <input type="radio" name={`${id}-vis`} value={v} checked={v === vis} disabled={off || locked} onChange={() => choose(v)} />
              <span className="kpax-option-text">
                <span className="kpax-option-name">{v !== "workspace" && <Icon name="lock" size={12} sw={2} />}{VISIBILITY_LABEL[v]}</span>
                <span className="kpax-option-line">{LINES[v]} <span className="kpax-count">{people(n)} can see it</span></span>
                {off && <span className="kpax-option-line">An owner can let members make projects private.</span>}
                {!off && locked && <span className="kpax-option-line">You'd lose access yourself. Ask an owner.</span>}
              </span>
            </label>
          );
        })}
      </fieldset>

      {asking && (
        <div className="kpax-ask" role="alertdialog" aria-labelledby={`${id}-ask`}>
          <p id={`${id}-ask`} className="kpax-ask-text">{narrowingQuestion(project.name, asking, loss)}</p>
          <div className="kpax-ask-actions">
            <Button size="sm" variant="primary" loading={busy} onClick={() => void run(() => onSetVisibility(project.id, asking))}>
              {asking === "private" ? "Make it private" : "Make it members only"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAsking(null)} disabled={busy}>Cancel</Button>
          </div>
        </div>
      )}

      <div className="kpax-group">
        <h3 className="kpax-legend">People</h3>
        {vis === "workspace" && <p className="kpax-note">Everyone here can edit a Whole workspace project. Roles apply to guests, and if you make it Members only or Private.</p>}
        <ul className="kpax-people">
          {ownerId && (
            <li className="kpax-person">
              <Avatar id={ownerId} size={24} />
              <span className="kpax-name">{nameOf(ownerId)}</span>
              <span className="kpax-role-fixed">Owner</span>
            </li>
          )}
          {onList.map((m) => {
            const isGuest = guest(m.userId);
            const effective = rankFor(ctx, m.userId, wsId, project.id);
            return (
              <li key={m.userId} className="kpax-person">
                <Avatar id={m.userId} size={24} />
                <span className="kpax-name">{nameOf(m.userId)}{isGuest && <span className="kpax-badge">Guest</span>}</span>
                {manage ? (
                  <>
                    <select className="kpax-select" aria-label={`${nameOf(m.userId)}'s role`} value={m.role} disabled={busy}
                      onChange={(e) => void run(() => onSetMember(project.id, m.userId, e.target.value as ProjectRole))}>
                      {(isGuest ? (["commenter", "viewer"] as ProjectRole[]) : (["editor", "commenter", "viewer"] as ProjectRole[])).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                    </select>
                    <Button size="sm" variant="ghost" disabled={busy} aria-label={`Remove ${nameOf(m.userId)}`} onClick={() => void run(() => onRemoveMember(project.id, m.userId))}>Remove</Button>
                  </>
                ) : <span className="kpax-role-fixed" title={effective === 3 && m.role !== "editor" ? "Everyone here can edit a Whole workspace project" : undefined}>{ROLE_LABEL[m.role]}</span>}
              </li>
            );
          })}
        </ul>
        {onList.some((m) => guest(m.userId)) && manage && <p className="kpax-note">Guests can comment at most.</p>}
      </div>

      {manage && (
        <div className="kpax-group kpax-add">
          {addable.length > 0 && (
            <span className="kpax-add-row">
              <select className="kpax-select" aria-label="Add someone to this project" value={adding} onChange={(e) => setAdding(e.target.value)} disabled={busy}>
                <option value="">Add people…</option>
                {addable.map((m) => <option key={m.userId!} value={m.userId!}>{nameOf(m.userId!)}{m.role === "guest" ? " (guest)" : ""}</option>)}
              </select>
              <Button size="sm" icon="plus" disabled={!adding || busy}
                onClick={() => { const u = adding; setAdding(""); void run(() => onSetMember(project.id, u, guest(u) ? "commenter" : "editor")); }}>Add</Button>
            </span>
          )}
          {onInviteGuest && <Button size="sm" variant="ghost" icon="send" onClick={() => onInviteGuest(project.id)}>Invite a guest</Button>}
        </div>
      )}

      {notionSynced && <p className="kpax-note">This project syncs to Notion, so people with access there can see its tasks.</p>}
      {!manage && <p className="kpax-note">Only its owner and editors can change who has access.</p>}
    </section>
  );
}

/** About's one-line summary while project access is on: "4 people · Members only". */
export function accessSummary(project: Project, ctx: AccessCtx): string {
  const n = (ctx.members ?? []).filter((m) => m.projectId === project.id && m.userId !== project.ownerId).length + (project.ownerId ? 1 : 0);
  return `${people(n)} · ${VISIBILITY_LABEL[visibilityOf(project)]}`;
}

/** Is this person on the project (its owner, or a row in project_members)? */
export const onProject = (project: Project, ctx: AccessCtx, userId: string) => project.ownerId === userId || memberRole(ctx, project.id, userId) !== null;
