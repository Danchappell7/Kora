/* ============================================================
   KANBO — delete-project confirmation
   Offers the safe path first: archive the project (restorable), move its
   tasks to another project in the same workspace, or — only when chosen
   explicitly — delete the tasks too. Archived tasks are counted, never
   silently destroyed.
   ============================================================ */
import { useState, useEffect, useRef, type ReactNode } from "react";
import { Button, Icon, Sheet } from "./primitives";
import type { Project, IconName } from "../data/types";
import "./project/projects.css";

export type DeleteMode = "reassign" | "delete";
type Choice = DeleteMode | "archive";

const n = (count: number, word = "task") => `${count} ${word}${count === 1 ? "" : "s"}`;

export function DeleteProjectModal({ project, taskCount, archivedCount = 0, projects, onConfirm, onArchive, onClose }: {
  project: Project;
  /** tasks in the project that are NOT archived (open or done) */
  taskCount: number;
  /** archived tasks in the project — they move or get deleted along with the rest */
  archivedCount?: number;
  projects: Project[];
  onConfirm: (mode: DeleteMode, targetProjectId?: string) => void;
  /** when given, "Archive instead" is offered — and chosen by default. The
   *  modal calls onClose() straight after it, so this only needs to archive. */
  onArchive?: () => void;
  onClose: () => void;
}) {
  // tasks can only move within the same workspace — team work never leaks
  // into someone's Personal space (and the server would refuse it anyway)
  const others = projects.filter((p) => p.id !== project.id && !p.archivedAt && (p.workspaceId ?? null) === (project.workspaceId ?? null));
  const canMove = others.length > 0;
  const archived = Math.max(0, archivedCount);
  const total = taskCount + archived;

  // safest sensible default: archive (restorable) > move > nothing. Delete is
  // only ever pre-chosen for a project with no tasks at all, archived or not.
  const initialChoice = (): Choice | null =>
    onArchive ? "archive" : total > 0 && canMove ? "reassign" : total === 0 ? "delete" : null;
  const [choice, setChoice] = useState<Choice | null>(initialChoice);
  const [target, setTarget] = useState(others[0]?.id || "");
  const bodyRef = useRef<HTMLDivElement>(null);
  const groupRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setChoice(initialChoice()); setTarget(others[0]?.id || ""); /* eslint-disable-next-line */ }, [project.id]);
  // keep the target valid if the project list changes underneath us
  useEffect(() => { if (target && !others.some((p) => p.id === target)) setTarget(others[0]?.id || ""); /* eslint-disable-next-line */ }, [others.map((p) => p.id).join("|")]);
  // start keyboard focus on the chosen option (Escape/Tab then work at once)
  useEffect(() => {
    const t = window.setTimeout(() => {
      const el = groupRef.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]') ?? groupRef.current?.querySelector<HTMLElement>('[role="radio"]') ?? bodyRef.current?.closest('[role="dialog"]')?.querySelector<HTMLElement>("[data-autofocus]");
      el?.focus();
    }, 30);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  const options: { value: Choice; icon: IconName; title: string; desc: string; danger?: boolean; extra?: ReactNode }[] = [];
  if (onArchive) options.push({
    value: "archive", icon: "archive", title: "Archive instead",
    desc: total > 0 ? `Hide the project and keep all ${n(total)}. Restore it any time from Archived in the sidebar.` : "Hide the project. Restore it any time from Archived in the sidebar.",
  });
  if (total > 0 && canMove) options.push({
    value: "reassign", icon: "arrowUpRight", title: `Move ${n(total)} to another project`,
    desc: archived > 0 ? `Includes ${archived} archived. Then the project is deleted.` : "Then the project is deleted.",
    // The picker only joins the Tab order once "Move" is chosen, and merely
    // focusing it never changes the choice — tabbing from the (default)
    // Archive option to the confirm button must not turn it into a delete.
    // Picking a target, or clicking the picker, is an explicit choice.
    extra: (
      <select className="kpj-field" value={target} aria-label={`Move tasks from ${project.name} to`}
        tabIndex={choice === "reassign" ? 0 : -1}
        onChange={(e) => { setTarget(e.target.value); setChoice("reassign"); }}
        onMouseDown={() => setChoice("reassign")}
        style={{ width: "100%", marginTop: 8, opacity: choice === "reassign" ? 1 : 0.7 }}>
        {others.map((p) => <option key={p.id} value={p.id}>{p.emoji} {p.name}</option>)}
      </select>
    ),
  });
  options.push(total > 0
    ? { value: "delete", icon: "trash", danger: true, title: `Delete ${n(total)} too`, desc: `${archived > 0 ? `Includes ${archived} archived. ` : ""}Permanently deletes the project and every task in it. This can't be undone.` }
    : { value: "delete", icon: "trash", danger: true, title: "Delete the project", desc: "It has no tasks. This can't be undone." });

  // an empty project with no archive option has nothing to choose between
  const showChoices = options.length > 1 || total > 0;

  // arrow keys move between options (radio-group behaviour)
  const onGroupKey = (e: React.KeyboardEvent) => {
    if (!["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft"].includes(e.key)) return;
    if ((e.target as HTMLElement).tagName === "SELECT") return;
    e.preventDefault();
    const fwd = e.key === "ArrowDown" || e.key === "ArrowRight";
    const i = options.findIndex((o) => o.value === choice);
    const next = i === -1 ? options[fwd ? 0 : options.length - 1] : options[(i + (fwd ? 1 : -1) + options.length) % options.length];
    setChoice(next.value);
    groupRef.current?.querySelector<HTMLElement>(`[data-choice="${next.value}"]`)?.focus();
  };

  const ready = choice === "archive" || choice === "delete" || (choice === "reassign" && !!target);
  const confirm = () => {
    if (!ready) return;
    if (choice === "archive") { onArchive?.(); onClose(); return; }
    if (choice === "reassign") { onConfirm("reassign", target); return; }
    onConfirm("delete");
  };
  const cta = choice === "archive" ? "Archive project"
    : choice === "reassign" ? "Move tasks & delete"
    : choice === "delete" && total > 0 ? `Delete project and ${n(total)}`
    : "Delete project";
  const danger = choice !== "archive";

  const descId = `kdelproj-desc-${project.id}`;
  const hintId = `kdelproj-hint-${project.id}`;
  const summary = total === 0
    ? " This project has no tasks."
    : archived > 0 && taskCount > 0 ? <> It has <strong>{n(taskCount)}</strong> and <strong>{archived} archived</strong>. What should happen to them?</>
    : archived > 0 ? <> It has no active tasks, but <strong>{n(archived, "archived task")}</strong>. What should happen to {archived === 1 ? "it" : "them"}?</>
    : <> It has <strong>{n(taskCount)}</strong>. What should happen to {taskCount === 1 ? "it" : "them"}?</>;

  return (
    <Sheet open onClose={onClose} label="Delete project" title="Delete project" width={480}
      footer={(
        <>
          {!ready && <span id={hintId} className="kpj-hint" style={{ marginRight: "auto" }}>{choice === "reassign" ? "Choose a project to move the tasks to." : "Choose what happens to the tasks first."}</span>}
          <Button variant="ghost" onClick={onClose} data-autofocus>Cancel</Button>
          <Button variant={danger ? "danger" : "primary"} icon={choice === "archive" ? "archive" : "trash"} onClick={confirm} disabled={!ready}
            aria-describedby={!ready ? hintId : undefined}>{cta}</Button>
        </>
      )}>
      <div ref={bodyRef} className="kpj-dialog">
        <p id={descId} className="kpj-dialog-text">
          Delete <strong>{project.emoji} {project.name}</strong>?{summary}
        </p>
        {showChoices && (
          <div ref={groupRef} role="radiogroup" aria-label={`What should happen to ${project.name}`} aria-describedby={descId} onKeyDown={onGroupKey} className="kpj-choices">
            {options.map((o) => {
              const active = choice === o.value;
              return (
                <div key={o.value} className="kpj-choice" data-active={active || undefined} data-tone={o.danger ? "danger" : undefined} onClick={() => setChoice(o.value)}>
                  <button type="button" role="radio" aria-checked={active} data-choice={o.value} tabIndex={active || (choice === null && o === options[0]) ? 0 : -1}
                    className="kpj-choice-btn" onClick={(e) => { e.stopPropagation(); setChoice(o.value); }}>
                    <span aria-hidden="true" className="kpj-radio" />
                    <Icon name={o.icon} size={16} sw={1.75} className="kpj-choice-icon" />
                    <span className="kpj-choice-text">
                      <span className="kpj-choice-title">{o.title}</span>
                      <span className="kpj-choice-desc">{o.desc}</span>
                    </span>
                  </button>
                  {o.extra && <div onClick={(e) => e.stopPropagation()} className="kpj-choice-extra">{o.extra}</div>}
                </div>
              );
            })}
            {total > 0 && !canMove && (
              <p className="kpj-hint" style={{ margin: 0 }}>
                There's no other project in this {project.workspaceId ? "workspace" : "space"} to move the tasks to.
              </p>
            )}
          </div>
        )}
      </div>
    </Sheet>
  );
}
