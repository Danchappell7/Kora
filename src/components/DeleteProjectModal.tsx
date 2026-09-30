/* ============================================================
   KANBO — delete-project confirmation
   Offers the safe path first: archive the project (restorable), move its
   tasks to another project in the same workspace, or — only when chosen
   explicitly — delete the tasks too. Archived tasks are counted, never
   silently destroyed.
   ============================================================ */
import { useState, useEffect, useRef, type ReactNode } from "react";
import { Icon } from "./primitives";
import { useFocusTrap } from "../hooks/useFocusTrap";
import type { Project, IconName } from "../data/types";

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
  const trapRef = useFocusTrap<HTMLDivElement>(true, onClose);
  const groupRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setChoice(initialChoice()); setTarget(others[0]?.id || ""); /* eslint-disable-next-line */ }, [project.id]);
  // keep the target valid if the project list changes underneath us
  useEffect(() => { if (target && !others.some((p) => p.id === target)) setTarget(others[0]?.id || ""); /* eslint-disable-next-line */ }, [others.map((p) => p.id).join("|")]);
  // start keyboard focus on the chosen option (Escape/Tab then work at once)
  useEffect(() => {
    const t = window.setTimeout(() => {
      const el = groupRef.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]') ?? groupRef.current?.querySelector<HTMLElement>('[role="radio"]') ?? trapRef.current?.querySelector<HTMLElement>("[data-autofocus]");
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
      <select value={target} aria-label={`Move tasks from ${project.name} to`}
        tabIndex={choice === "reassign" ? 0 : -1}
        onChange={(e) => { setTarget(e.target.value); setChoice("reassign"); }}
        onMouseDown={() => setChoice("reassign")}
        style={{ height: 34, width: "100%", marginTop: 9, padding: "0 11px", borderRadius: 9, border: "1px solid var(--hairline)", background: "var(--surface-raised)", color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 13.5, opacity: choice === "reassign" ? 1 : 0.7, transition: "opacity .14s" }}>
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

  const titleId = `kdelproj-title-${project.id}`;
  const descId = `kdelproj-desc-${project.id}`;
  const hintId = `kdelproj-hint-${project.id}`;
  const summary = total === 0
    ? " This project has no tasks."
    : archived > 0 && taskCount > 0 ? <> It has <strong style={{ color: "var(--ink)" }}>{n(taskCount)}</strong> and <strong style={{ color: "var(--ink)" }}>{archived} archived</strong> — what should happen to them?</>
    : archived > 0 ? <> It has no active tasks, but <strong style={{ color: "var(--ink)" }}>{n(archived, "archived task")}</strong> — what should happen to {archived === 1 ? "it" : "them"}?</>
    : <> It has <strong style={{ color: "var(--ink)" }}>{n(taskCount)}</strong> — what should happen to {taskCount === 1 ? "it" : "them"}?</>;

  return (
    <div onClick={onClose} className="kbackdrop" style={{ position: "fixed", inset: 0, zIndex: 115, background: "color-mix(in oklch, var(--bg-deep) 60%, transparent)", backdropFilter: "blur(6px)", display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "14vh", paddingLeft: 16, paddingRight: 16 }}>
      <div ref={trapRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descId} onClick={(e) => e.stopPropagation()} className="glass anim-scalein" style={{ width: 460, maxWidth: "100%", maxHeight: "80vh", overflowY: "auto", borderRadius: 18, background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "16px 18px", borderBottom: "1px solid var(--hairline)" }}>
          <span aria-hidden="true" style={{ display: "grid", placeItems: "center", width: 30, height: 30, borderRadius: 9, background: "color-mix(in oklch, var(--st-blocked) 14%, transparent)", color: "var(--st-blocked)" }}><Icon name="trash" size={17} /></span>
          <h2 id={titleId} style={{ fontSize: 15, fontWeight: 600, letterSpacing: "-0.01em" }}>Delete project</h2>
          <button className="btn-icon" onClick={onClose} aria-label="Close" style={{ marginLeft: "auto", border: "none", width: 30, height: 30 }}><Icon name="x" size={17} /></button>
        </div>

        <div style={{ padding: 18 }}>
          <p id={descId} style={{ margin: "0 0 16px", fontSize: 14, lineHeight: 1.5, color: "var(--ink-2)" }}>
            Delete <strong style={{ color: "var(--ink)" }}>{project.emoji} {project.name}</strong>?{summary}
          </p>

          {showChoices && <div ref={groupRef} role="radiogroup" aria-label={`What should happen to ${project.name}`} onKeyDown={onGroupKey} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {options.map((o) => {
              const active = choice === o.value;
              const tone = o.danger ? "var(--st-blocked)" : "var(--accent)";
              return (
                <div key={o.value} onClick={() => setChoice(o.value)} style={{
                  padding: "12px 13px", borderRadius: 12, cursor: "pointer",
                  border: `1px solid ${active ? tone : "var(--hairline)"}`,
                  background: active ? `color-mix(in oklch, ${tone} 10%, transparent)` : "var(--surface)",
                  transition: "border-color .14s, background .14s",
                }}>
                  <button type="button" role="radio" aria-checked={active} data-choice={o.value} tabIndex={active || (choice === null && o === options[0]) ? 0 : -1}
                    onClick={(e) => { e.stopPropagation(); setChoice(o.value); }}
                    style={{ display: "flex", alignItems: "flex-start", gap: 11, width: "100%", padding: 0, border: "none", background: "transparent", cursor: "pointer", textAlign: "left", color: "var(--ink)", fontFamily: "var(--font-display)", borderRadius: 8 }}>
                    <span aria-hidden="true" style={{ display: "grid", placeItems: "center", width: 18, height: 18, marginTop: 1, borderRadius: 99, flexShrink: 0, border: `1.5px solid ${active ? tone : "var(--hairline-strong)"}`, background: "var(--surface-raised)" }}>
                      {active && <span style={{ width: 8, height: 8, borderRadius: 99, background: tone }} />}
                    </span>
                    <Icon name={o.icon} size={16} style={{ color: active ? tone : "var(--ink-3)", marginTop: 1.5, flexShrink: 0 }} />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: "block", fontSize: 13.5, fontWeight: 600 }}>{o.title}</span>
                      <span style={{ display: "block", fontSize: 12, color: "var(--ink-3)", marginTop: 2, lineHeight: 1.45 }}>{o.desc}</span>
                    </span>
                  </button>
                  {o.extra && <div onClick={(e) => e.stopPropagation()} style={{ paddingLeft: 56 }}>{o.extra}</div>}
                </div>
              );
            })}
            {total > 0 && !canMove && (
              <p style={{ margin: 0, fontSize: 12.5, color: "var(--ink-3)", padding: "0 2px" }}>
                There's no other project in this {project.workspaceId ? "workspace" : "space"} to move the tasks to.
              </p>
            )}
          </div>}
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 10, padding: "14px 18px", borderTop: "1px solid var(--hairline)", flexWrap: "wrap" }}>
          {!ready && <span id={hintId} style={{ marginRight: "auto", fontSize: 12.5, color: "var(--ink-3)" }}>{choice === "reassign" ? "Choose a project to move the tasks to." : "Choose what happens to the tasks first."}</span>}
          <button className="btn btn-ghost" onClick={onClose} data-autofocus>Cancel</button>
          <button className={danger ? "btn" : "btn btn-accent"} onClick={confirm} disabled={!ready} aria-describedby={!ready ? hintId : undefined}
            style={danger ? { background: "var(--danger-fill, var(--st-blocked))", color: "oklch(0.99 0.01 20)", fontWeight: 650, opacity: ready ? 1 : 0.5, cursor: ready ? "pointer" : "not-allowed" } : undefined}>
            <Icon name={choice === "archive" ? "archive" : "trash"} size={15} /> {cta}
          </button>
        </div>
      </div>
    </div>
  );
}
