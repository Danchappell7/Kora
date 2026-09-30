/* ============================================================
   KANBO — Team › Pulse: the standup that writes itself, with the
   Radar of risks beside it.
   W0 stub: an empty state that points to Workload; P08 builds it.
   ============================================================ */
import { Icon, EmptyArt } from "../primitives";
import type { Task, WorkspaceMember, WorkspaceEvent } from "../../data/types";
import type { AiOutcome } from "../../lib/askTypes";

export function TeamPulse({ onOpenWorkload }: {
  tasks: Task[];
  members: WorkspaceMember[];
  currentUserId: string;
  workspaceName: string;
  readOnly: boolean;
  loadEvents: (sinceISO: string) => Promise<WorkspaceEvent[]>;
  onOpen: (id: string) => void;
  onNudge: (taskId: string, userId: string, text: string) => Promise<void>;
  onPatch: (id: string, patch: Partial<Task>) => void;
  onOpenWorkload: () => void;
  onWriteUp?: (facts: unknown) => Promise<AiOutcome<string>>;
}) {
  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px 40px", display: "grid", placeItems: "center" }}>
      <div style={{ textAlign: "center", color: "var(--ink-4)", maxWidth: 440 }}>
        <div style={{ marginBottom: 14 }}><EmptyArt kind="users" /></div>
        <p style={{ fontSize: 16, color: "var(--ink)", margin: 0, fontWeight: 600, fontFamily: "var(--font-head)", letterSpacing: "-0.01em" }}>Pulse is on its way</p>
        <p style={{ fontSize: 13, margin: "5px 0 16px", lineHeight: 1.5 }}>A daily standup that writes itself, with the risks worth a look. Until then, Workload shows who's carrying what.</p>
        <button className="btn btn-ghost" onClick={onOpenWorkload}>Open Workload <Icon name="arrowRight" size={14} /></button>
      </div>
    </div>
  );
}
