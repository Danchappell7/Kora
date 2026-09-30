/* ============================================================
   KANBO — Projects › All: the workspace's project directory.
   W0 stub: a plain list of the projects; P11 builds the directory.
   ============================================================ */
import { Icon, EmptyArt } from "../primitives";
import type { Task, Project, StatusUpdate, StatusKind } from "../../data/types";
import type { AiOutcome } from "../../lib/askTypes";

export function ProjectsView({ projects, tasks, canCreate, onOpenProject, onNewProject }: {
  projects: Project[];
  tasks: Task[];
  statusUpdates: StatusUpdate[];
  members: { id: string; name: string }[];
  currentUserId: string;
  canCreate: boolean;
  onOpenProject: (id: string) => void;
  onNewProject: () => void;
  onPostUpdate?: (projectId: string, summary: string, status: StatusKind) => Promise<boolean> | void;
  aiStatus?: (facts: unknown) => Promise<AiOutcome<{ summary: string; status: StatusKind }>>;
  risksByProject?: Record<string, number>;
}) {
  if (projects.length === 0) {
    return (
      <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px 40px", display: "grid", placeItems: "center" }}>
        <div style={{ textAlign: "center", color: "var(--ink-4)", maxWidth: 440 }}>
          <div style={{ marginBottom: 14 }}><EmptyArt kind="folder" /></div>
          <p style={{ fontSize: 16, color: "var(--ink)", margin: 0, fontWeight: 600, fontFamily: "var(--font-head)", letterSpacing: "-0.01em" }}>No projects yet</p>
          <p style={{ fontSize: 13, margin: "5px 0 16px", lineHeight: 1.5 }}>Projects keep a piece of work's tasks, updates and people together.</p>
          {canCreate && <button className="btn btn-accent" onClick={onNewProject}><Icon name="plus" size={15} /> New project</button>}
        </div>
      </div>
    );
  }
  const openCount = (id: string) => tasks.filter((t) => t.projectId === id && t.status !== "done" && !t.archivedAt && !t.parentId).length;
  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "16px 24px 40px" }}>
      <ul aria-label="Projects" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 2, maxWidth: 880 }}>
        {projects.map((p) => {
          const open = openCount(p.id);
          return (
            <li key={p.id}>
              <button onClick={() => onOpenProject(p.id)}
                style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", minHeight: 40, padding: "8px 10px", borderRadius: 8, border: "none", background: "transparent", cursor: "pointer", textAlign: "left", fontFamily: "var(--font-display)", color: "var(--ink)" }}>
                <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 3, background: p.color, flexShrink: 0 }} />
                <span className="truncate" style={{ flex: 1, fontSize: 14, fontWeight: 500 }}>{p.name}</span>
                <span className="mono tnum" style={{ fontSize: 11, color: "var(--ink-4)" }}>{open} open</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
