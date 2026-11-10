/* ============================================================
   KANBO — add several projects to a portfolio at once (0054). Tap
   projects to pick them (grouped by business in a Personal portfolio),
   then "Add 3 projects". Escape puts it away. Used by the Portfolios
   list (Cards and Table) and a portfolio's own page.
   ============================================================ */
import { useState, type KeyboardEvent } from "react";
import { Button, ProjectTile } from "../primitives";
import type { Project, Workspace } from "../../data/types";
import { WorkspaceMark } from "../businesses/Businesses";
import "./portfolio.css";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function AddProjectsPicker({ portfolioName, available, workspaces, onAdd, onCancel, emptyNote }: {
  portfolioName: string;
  /** the projects that can still be added */
  available: Project[];
  /** across businesses: group them under each business */
  workspaces?: Workspace[];
  onAdd: (ids: string[]) => void;
  onCancel: () => void;
  /** said when there's nothing left to add */
  emptyNote: string;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const toggle = (id: string) => setPicked((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id]));
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => { if (e.key === "Escape") { e.stopPropagation(); onCancel(); } };
  if (!available.length) {
    return (
      <div className="kpf-pick" role="group" aria-label={`Add projects to ${portfolioName}`} onKeyDown={onKeyDown}>
        <p className="kpf-pick-note">{emptyNote}</p>
        <div className="kpf-pick-foot"><Button variant="ghost" size="sm" onClick={onCancel}>Close</Button></div>
      </div>
    );
  }
  const chip = (p: Project) => (
    <button key={p.id} type="button" className="kpf-pick-chip" aria-pressed={picked.includes(p.id)} onClick={() => toggle(p.id)}>
      <ProjectTile project={p} size={16} />
      <span>{p.name}</span>
    </button>
  );
  const groups = workspaces
    ? workspaces.map((w) => ({ w, list: available.filter((p) => (p.workspaceId ?? null) === (w.id ?? null)) })).filter((g) => g.list.length)
    : null;
  const all = picked.length === available.length;
  return (
    <div className="kpf-pick" role="group" aria-label={`Add projects to ${portfolioName}`} onKeyDown={onKeyDown}>
      <div className="kpf-pick-head">
        <span className="kpf-pick-title">Pick the projects to add</span>
        <Button variant="ghost" size="sm" onClick={() => setPicked(all ? [] : available.map((p) => p.id))}>{all ? "Clear" : "Select all"}</Button>
      </div>
      {groups ? groups.map(({ w, list }) => (
        <div key={w.id ?? "personal"} className="kpf-pick-group" role="group" aria-label={w.name}>
          <span className="kpf-pick-biz" aria-hidden="true"><WorkspaceMark workspace={w} size={16} />{w.name}</span>
          <div className="kpf-pick-chips">{list.map(chip)}</div>
        </div>
      )) : <div className="kpf-pick-chips">{available.map(chip)}</div>}
      <div className="kpf-pick-foot">
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button variant="primary" size="sm" disabled={!picked.length} onClick={() => onAdd(picked)}>
          {picked.length ? `Add ${plural(picked.length, "project")}` : "Add projects"}
        </Button>
      </div>
    </div>
  );
}
