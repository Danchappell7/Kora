/* ============================================================
   KORA — delete-project confirmation
   Asks whether to move the project's tasks elsewhere or delete them.
   ============================================================ */
import { useState, useEffect } from "react";
import { Icon } from "./primitives";
import { useFocusTrap } from "../hooks/useFocusTrap";
import type { Project } from "../data/types";

export type DeleteMode = "reassign" | "delete";

export function DeleteProjectModal({ project, taskCount, projects, onConfirm, onClose }: {
  project: Project;
  taskCount: number;
  projects: Project[];
  onConfirm: (mode: DeleteMode, targetProjectId?: string) => void;
  onClose: () => void;
}) {
  const others = projects.filter((p) => p.id !== project.id);
  const [mode, setMode] = useState<DeleteMode>("reassign");
  const [target, setTarget] = useState(others[0]?.id || "p-personal");
  const trapRef = useFocusTrap<HTMLDivElement>(true, onClose);

  useEffect(() => { setMode("reassign"); setTarget(others[0]?.id || "p-personal"); /* eslint-disable-next-line */ }, [project.id]);

  const plural = `${taskCount} task${taskCount === 1 ? "" : "s"}`;

  const optionStyle = (active: boolean): React.CSSProperties => ({
    display: "flex", alignItems: "center", gap: 11, width: "100%", padding: "12px 13px", borderRadius: 12, cursor: "pointer", textAlign: "left",
    border: `1px solid ${active ? "var(--accent)" : "var(--hairline)"}`,
    background: active ? "var(--accent-dim)" : "var(--surface)", transition: "all .14s",
  });

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 115, background: "color-mix(in oklch, var(--bg-deep) 60%, transparent)", backdropFilter: "blur(6px)", display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "14vh" }}>
      <div ref={trapRef} role="dialog" aria-modal="true" aria-label="Delete project" onClick={(e) => e.stopPropagation()} className="glass anim-scalein" style={{ width: 460, maxWidth: "92vw", borderRadius: 18, overflow: "hidden", background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "16px 18px", borderBottom: "1px solid var(--hairline)" }}>
          <span style={{ display: "grid", placeItems: "center", width: 30, height: 30, borderRadius: 9, background: "color-mix(in oklch, var(--st-blocked) 14%, transparent)", color: "var(--st-blocked)" }}><Icon name="trash" size={17} /></span>
          <span style={{ fontSize: 15, fontWeight: 600 }}>Delete project</span>
          <button className="btn-icon" onClick={onClose} style={{ marginLeft: "auto", border: "none", width: 30, height: 30 }}><Icon name="x" size={17} /></button>
        </div>

        <div style={{ padding: 18 }}>
          <p style={{ margin: "0 0 16px", fontSize: 14, lineHeight: 1.5, color: "var(--ink-2)" }}>
            Delete <strong style={{ color: "var(--ink)" }}>{project.emoji} {project.name}</strong>?
            {taskCount > 0 ? <> It has <strong style={{ color: "var(--ink)" }}>{plural}</strong> — what should happen to {taskCount === 1 ? "it" : "them"}?</> : " This project has no tasks."}
          </p>

          {taskCount > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <button style={optionStyle(mode === "reassign")} onClick={() => setMode("reassign")}>
                <Icon name="arrowUpRight" size={17} style={{ color: mode === "reassign" ? "var(--accent)" : "var(--ink-3)" }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600 }}>Move {plural} to another project</div>
                  <div style={{ marginTop: 8 }} onClick={(e) => e.stopPropagation()}>
                    <select value={target} onChange={(e) => setTarget(e.target.value)} disabled={mode !== "reassign"}
                      style={{ height: 34, width: "100%", padding: "0 11px", borderRadius: 9, border: "1px solid var(--hairline)", background: "var(--surface-raised)", color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 13.5, outline: "none", opacity: mode === "reassign" ? 1 : 0.5 }}>
                      {others.map((p) => <option key={p.id} value={p.id}>{p.emoji} {p.name}</option>)}
                    </select>
                  </div>
                </div>
              </button>
              <button style={optionStyle(mode === "delete")} onClick={() => setMode("delete")}>
                <Icon name="trash" size={17} style={{ color: mode === "delete" ? "var(--st-blocked)" : "var(--ink-3)" }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600 }}>Delete {plural} too</div>
                  <div style={{ fontSize: 12, color: "var(--ink-4)", marginTop: 2 }}>This can't be undone.</div>
                </div>
              </button>
            </div>
          )}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, padding: "14px 18px", borderTop: "1px solid var(--hairline)" }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn" onClick={() => onConfirm(taskCount === 0 ? "delete" : mode, mode === "reassign" ? target : undefined)}
            style={{ background: "var(--st-blocked)", color: "oklch(0.99 0.01 20)", fontWeight: 650 }}>
            <Icon name="trash" size={15} /> Delete project
          </button>
        </div>
      </div>
    </div>
  );
}
