/* ============================================================
   KANBO — a person's projects, in their Team profile (0058), for
   the workspace's owners and admins while project access is on:
   each project they're on with their role there (or, for a pending
   invite, the projects it will bring), changed or taken off here,
   and Add to a project. This is where "what can this guest see?" is
   answered in one place. Guests comment at most. The server decides
   every change; a refusal is said by the caller.
   ============================================================ */
import { useId, useState } from "react";
import { Button } from "../primitives";
import type { ProjectRole } from "../../data/types";
import { ROLE_LABEL } from "../../lib/projectAccess";
import "./memberProjects.css";

export interface MemberProjectRow { projectId: string; name: string; role: ProjectRole | "owner" }

export function MemberProjects({ name, guest, pending, rows, addable, partial = false, onSet, onRemove }: {
  /** whose they are */
  name: string;
  guest: boolean;
  /** a pending invite: these are the projects it brings when it's claimed */
  pending: boolean;
  /** the projects they're on (their own projects read "Owner": a guest who owns one comments on it) */
  rows: MemberProjectRow[];
  /** the projects you could add them to */
  addable: { id: string; name: string }[];
  /** you may not see all of their projects (an admin: Private ones you're not on): the hint says so */
  partial?: boolean;
  onSet: (projectId: string, role: ProjectRole) => Promise<boolean>;
  onRemove: (projectId: string) => Promise<boolean>;
}): JSX.Element {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState("");
  const first = name.trim().split(/\s+/)[0] || name;
  const run = async (f: () => Promise<boolean>) => {
    setBusy(true);
    try { await f(); } finally { setBusy(false); }
  };
  const roles: ProjectRole[] = guest ? ["commenter", "viewer"] : ["editor", "commenter", "viewer"];
  const of = partial ? " of the ones you can see" : "";
  const hint = (pending
    ? rows.length ? `${first} will see ${rows.length === 1 ? "this project" : "these projects"}${of} once they join.` : `${first} will see no projects${of} here until you add them to one.`
    : guest
      ? rows.length ? `${first} sees only ${rows.length === 1 ? "this project" : "these projects"}${of} here.` : `${first} sees no projects${of} here yet.`
      : `${first} also sees every Whole workspace project.`)
    + (partial && (pending || guest) ? " Private projects you're not on aren't listed." : "");
  return (
    <section className="kmprj" aria-labelledby={`${id}-t`}>
      <h3 id={`${id}-t`} className="kmprj-title">Projects</h3>
      <p className="kmprj-hint">{hint}</p>
      {rows.length > 0 && (
        <ul className="kmprj-list">
          {rows.map((r) => (
            <li key={r.projectId} className="kmprj-row">
              <span className="kmprj-name">{r.name}</span>
              {r.role === "owner" ? <span className="kmprj-fixed">{guest ? "Owner · can comment" : "Owner"}</span> : (
                <>
                  <select className="kmprj-select" aria-label={`${first}'s role on ${r.name}`} value={r.role} disabled={busy}
                    onChange={(e) => void run(() => onSet(r.projectId, e.target.value as ProjectRole))}>
                    {roles.map((x) => <option key={x} value={x}>{ROLE_LABEL[x]}</option>)}
                  </select>
                  <Button size="sm" variant="ghost" disabled={busy} aria-label={`Take ${first} off ${r.name}`} onClick={() => void run(() => onRemove(r.projectId))}>Remove</Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {addable.length > 0 && (
        <span className="kmprj-add">
          <select className="kmprj-select" aria-label={`Add ${first} to a project`} value={adding} disabled={busy} onChange={(e) => setAdding(e.target.value)}>
            <option value="">Add to a project…</option>
            {addable.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <Button size="sm" icon="plus" disabled={!adding || busy}
            onClick={() => { const p = adding; setAdding(""); void run(() => onSet(p, guest ? "commenter" : "editor")); }}>Add</Button>
        </span>
      )}
      {guest && rows.some((r) => r.role !== "owner") && <p className="kmprj-hint">Guests can comment at most.</p>}
    </section>
  );
}
