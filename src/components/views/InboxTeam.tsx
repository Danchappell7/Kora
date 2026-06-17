/* ============================================================
   KANBO — Inbox (real activity feed) & Team views
   ============================================================ */
import { useState } from "react";
import { Icon, Avatar } from "../primitives";
import { timeAgo } from "../../data/data";
import type { Task, WorkspaceMember, Activity, ActivityKind, IconName } from "../../data/types";

const KIND_META: Record<ActivityKind, { icon: IconName; color: string; verb: string }> = {
  created:   { icon: "plus",    color: "var(--accent)",     verb: "created" },
  status:    { icon: "refresh", color: "var(--st-progress)", verb: "updated" },
  completed: { icon: "check",   color: "var(--st-done)",    verb: "completed" },
  reopened:  { icon: "refresh", color: "var(--st-review)",  verb: "reopened" },
  comment:   { icon: "message", color: "var(--accent)",     verb: "commented on" },
  deleted:   { icon: "trash",   color: "var(--st-blocked)", verb: "deleted" },
  assigned:  { icon: "user",    color: "var(--accent)",     verb: "assigned you" },
  mention:   { icon: "message", color: "var(--accent)",     verb: "mentioned you in" },
};

const INBOX_FILTERS: { v: string; label: string; kinds?: ActivityKind[] }[] = [
  { v: "all", label: "All" },
  { v: "assigned", label: "Assigned", kinds: ["assigned"] },
  { v: "mention", label: "Mentions", kinds: ["mention"] },
  { v: "comment", label: "Comments", kinds: ["comment"] },
  { v: "updates", label: "Updates", kinds: ["created", "status", "completed", "reopened", "deleted"] },
];

export function InboxView({ activity, tasks, onOpen, onArchive, onClearAll }: {
  activity: Activity[];
  tasks: Task[];
  onOpen: (id: string) => void;
  onArchive: (id: string) => void;
  onClearAll: () => void;
}) {
  const [filter, setFilter] = useState("all");
  const activeFilter = INBOX_FILTERS.find((f) => f.v === filter) || INBOX_FILTERS[0];
  const shown = activeFilter.kinds ? activity.filter((a) => activeFilter.kinds!.includes(a.kind)) : activity;
  if (activity.length === 0) {
    return (
      <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px 40px", display: "grid", placeItems: "center" }}>
        <div style={{ textAlign: "center", color: "var(--ink-4)", maxWidth: 420 }}>
          <div style={{ display: "inline-flex", padding: 14, borderRadius: 16, background: "var(--surface)", border: "1px solid var(--hairline)", marginBottom: 14 }}><Icon name="inbox" size={24} style={{ color: "var(--ink-4)" }} /></div>
          <p style={{ fontSize: 14.5, color: "var(--ink-2)", margin: 0, fontWeight: 600 }}>You're all caught up</p>
          <p style={{ fontSize: 13, margin: "5px 0 0", lineHeight: 1.5 }}>Activity on your tasks — creates, completions, comments — shows up here. Archived items stay in your history.</p>
        </div>
      </div>
    );
  }
  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px 40px", maxWidth: 760, width: "100%", margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        <div style={{ display: "inline-flex", gap: 2, padding: 3, borderRadius: 9, background: "var(--surface)", border: "1px solid var(--hairline)" }}>
          {INBOX_FILTERS.map((f) => {
            const n = f.kinds ? activity.filter((a) => f.kinds!.includes(a.kind)).length : activity.length;
            return (
              <button key={f.v} onClick={() => setFilter(f.v)} style={{ padding: "5px 11px", borderRadius: 7, border: "none", cursor: "pointer", fontFamily: "var(--font-display)", fontSize: 12.5, fontWeight: 500, background: filter === f.v ? "var(--accent)" : "transparent", color: filter === f.v ? "var(--on-accent)" : "var(--ink-3)" }}>{f.label}{f.v !== "all" && n > 0 ? ` ${n}` : ""}</button>
            );
          })}
        </div>
        <button className="btn btn-ghost" onClick={onClearAll} style={{ marginLeft: "auto", fontSize: 13 }}>
          <Icon name="archive" size={15} /> Mark all read
        </button>
      </div>
      {shown.length === 0 ? (
        <div style={{ textAlign: "center", padding: "48px 24px", color: "var(--ink-4)", fontSize: 13 }}>No {activeFilter.label.toLowerCase()} updates.</div>
      ) : (
      <div className="glass" style={{ borderRadius: 16, overflow: "hidden" }}>
        {shown.map((a, i) => {
          const meta = KIND_META[a.kind] ?? KIND_META.status;
          const taskStillExists = a.taskId && tasks.some((t) => t.id === a.taskId);
          return (
            <div key={a.id} className="kinbox-row" style={{
              display: "flex", alignItems: "center", gap: 13, width: "100%", padding: "13px 18px",
              borderTop: i ? "1px solid var(--hairline)" : "none", transition: "background .14s",
            }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-2)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
              <span style={{ display: "grid", placeItems: "center", width: 32, height: 32, borderRadius: 99, flexShrink: 0, background: `color-mix(in oklch, ${meta.color} 14%, transparent)`, color: meta.color }}>
                <Icon name={meta.icon} size={15} />
              </span>
              <button onClick={() => taskStillExists && onOpen(a.taskId!)} style={{
                flex: 1, minWidth: 0, display: "block", textAlign: "left", border: "none", background: "transparent",
                padding: 0, cursor: taskStillExists ? "pointer" : "default", fontFamily: "var(--font-display)",
              }}>
                <div className="truncate" style={{ fontSize: 13.5, color: "var(--ink-2)" }}>
                  {a.kind === "assigned" || a.kind === "mention"
                    ? <><strong style={{ color: "var(--ink)" }}>{a.detail || "Someone"}</strong> {a.kind === "assigned" ? "assigned you" : "mentioned you in"} <strong style={{ color: "var(--ink)" }}>{a.taskTitle}</strong></>
                    : <>You {meta.verb} <strong style={{ color: "var(--ink)" }}>{a.taskTitle}</strong></>}
                </div>
                {a.kind !== "assigned" && a.kind !== "mention" && (
                  <div className="truncate" style={{ fontSize: 12, color: "var(--ink-4)", marginTop: 2 }}>
                    {a.kind === "comment" ? `“${a.detail}”` : a.detail}
                  </div>
                )}
              </button>
              <span className="mono" style={{ fontSize: 11, color: "var(--ink-4)", flexShrink: 0 }}>{timeAgo(a.createdAt)}</span>
              <button className="btn-icon kinbox-archive" title="Archive" aria-label="Archive this update"
                onClick={() => onArchive(a.id)}
                style={{ border: "none", width: 30, height: 30, flexShrink: 0, color: "var(--ink-4)" }}>
                <Icon name="archive" size={16} />
              </button>
            </div>
          );
        })}
      </div>
      )}
    </div>
  );
}

export function TeamView({ tasks, workspace, workspaces, members, currentUserId, onInvite, onRemoveMember, onNewWorkspace }: {
  tasks: Task[];
  workspace: string | null;
  workspaces: { id: string | null; name: string; ownerId?: string }[];
  members: WorkspaceMember[];
  currentUserId: string;
  onInvite: (workspaceId: string, email: string) => void;
  onRemoveMember: (memberId: string) => void;
  onNewWorkspace: () => void;
}) {
  const [email, setEmail] = useState("");
  const ws = workspaces.find((w) => w.id === workspace);
  const wsMembers = members.filter((m) => m.workspaceId === workspace);
  const active = wsMembers.filter((m) => m.status === "active");
  const invited = wsMembers.filter((m) => m.status === "invited");
  const isOwner = ws?.ownerId === currentUserId || active.some((m) => m.userId === currentUserId && m.role === "owner");

  // Personal workspace → prompt to create a team
  if (workspace === null) {
    return (
      <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px 40px", display: "grid", placeItems: "center" }}>
        <div style={{ textAlign: "center", color: "var(--ink-4)", maxWidth: 440 }}>
          <div style={{ display: "inline-flex", padding: 14, borderRadius: 16, background: "var(--surface)", border: "1px solid var(--hairline)", marginBottom: 14 }}><Icon name="users" size={24} style={{ color: "var(--ink-4)" }} /></div>
          <p style={{ fontSize: 14.5, color: "var(--ink-2)", margin: 0, fontWeight: 600 }}>Personal is just for you</p>
          <p style={{ fontSize: 13, margin: "5px 0 16px", lineHeight: 1.5 }}>Create a team workspace to invite people and collaborate on shared projects and tasks.</p>
          <button className="btn btn-accent" onClick={onNewWorkspace}><Icon name="plus" size={15} /> New workspace</button>
        </div>
      </div>
    );
  }

  const submitInvite = () => {
    const v = email.trim();
    if (!v || !/.+@.+\..+/.test(v) || !workspace) return;
    onInvite(workspace, v);
    setEmail("");
  };

  const MemberCard = ({ m }: { m: WorkspaceMember }) => {
    const memberId = m.userId ?? "";
    const assigned = tasks.filter((t) => t.assigneeId === memberId);
    const openN = assigned.filter((t) => t.status !== "done").length;
    const load = Math.min(100, openN * 25);
    const isSelf = m.userId === currentUserId;
    return (
      <div className="glass" style={{ padding: 18, borderRadius: 16, position: "relative" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
          {m.userId ? <Avatar id={m.userId} size={42} /> : (
            <span style={{ width: 42, height: 42, borderRadius: 99, display: "grid", placeItems: "center", background: "var(--surface-2)", border: "1px dashed var(--hairline-strong)", color: "var(--ink-4)" }}><Icon name="user" size={19} /></span>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14.5, fontWeight: 600 }}>
              {m.name || m.email}
              {isSelf && <span style={{ fontSize: 11, color: "var(--ink-4)", fontWeight: 400 }}> · you</span>}
            </div>
            <div className="truncate" style={{ fontSize: 12, color: "var(--ink-4)" }}>{m.email}</div>
          </div>
          <span className="mono" style={{ fontSize: 10, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase", padding: "2px 8px", borderRadius: 6,
            color: m.status === "invited" ? "var(--st-review)" : m.role === "owner" ? "var(--accent)" : "var(--ink-3)",
            background: m.status === "invited" ? "color-mix(in oklch, var(--st-review) 12%, transparent)" : "var(--surface-2)" }}>
            {m.status === "invited" ? "Invited" : m.role}
          </span>
          {isOwner && !isSelf && (
            <button className="btn-icon" title="Remove" aria-label={`Remove ${m.email}`} onClick={() => { if (window.confirm(`Remove ${m.name || m.email} from this workspace?`)) onRemoveMember(m.id); }}
              style={{ border: "none", width: 28, height: 28, color: "var(--ink-3)" }}><Icon name="x" size={15} /></button>
          )}
        </div>
        {m.status === "active" ? (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, marginBottom: 7 }}>
              <span className="kicker">Workload</span>
              <span className="mono tnum" style={{ color: load > 60 ? "var(--prio-high)" : "var(--ink-3)" }}>{openN} open</span>
            </div>
            <div style={{ height: 6, borderRadius: 99, background: "var(--surface-2)", overflow: "hidden" }}>
              <div style={{ width: load + "%", height: "100%", borderRadius: 99, background: load > 60 ? "var(--prio-high)" : "var(--accent)", transition: "width .8s var(--ease)" }} />
            </div>
          </>
        ) : (
          <p style={{ margin: 0, fontSize: 12.5, color: "var(--ink-4)", lineHeight: 1.5 }}>Will join when they sign in to Kanbo with this email.</p>
        )}
      </div>
    );
  };

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px 40px" }}>
      {/* invite */}
      {isOwner && (
        <div className="glass" style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 16px", borderRadius: 16, marginBottom: 24, flexWrap: "wrap" }}>
          <Icon name="users" size={17} style={{ color: "var(--accent)" }} />
          <span style={{ fontSize: 13.5, fontWeight: 600 }}>Invite to {ws?.name}</span>
          <input value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submitInvite(); }}
            type="email" placeholder="teammate@company.com" aria-label="Invite email"
            style={{ flex: 1, minWidth: 200, height: 38, padding: "0 13px", borderRadius: 10, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 13.5, outline: "none" }} />
          <button className="btn btn-accent" onClick={submitInvite} disabled={!/.+@.+\..+/.test(email)} style={{ opacity: /.+@.+\..+/.test(email) ? 1 : 0.5 }}>
            <Icon name="plus" size={15} /> Invite
          </button>
        </div>
      )}

      <div className="kicker" style={{ marginBottom: 12 }}>Members · {active.length}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(280px,1fr))", gap: 14, marginBottom: 28 }}>
        {active.map((m) => <MemberCard key={m.id} m={m} />)}
      </div>
      {invited.length > 0 && (
        <>
          <div className="kicker" style={{ marginBottom: 12 }}>Pending invites · {invited.length}</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(280px,1fr))", gap: 14 }}>
            {invited.map((m) => <MemberCard key={m.id} m={m} />)}
          </div>
        </>
      )}
    </div>
  );
}
