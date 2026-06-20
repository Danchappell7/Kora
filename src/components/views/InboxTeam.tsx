/* ============================================================
   KANBO — Inbox (real activity feed) & Team views
   ============================================================ */
import { useState } from "react";
import { Icon, Avatar, StatusDot } from "../primitives";
import { timeAgo, getProject } from "../../data/data";
import { can, canManageMember, assignableRoles, ROLE_META } from "../../lib/permissions";
import type { Task, WorkspaceMember, Role, Activity, ActivityKind, IconName } from "../../data/types";

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
          <Icon name="archive" size={15} /> Archive all
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

export function TeamView({ tasks, workspace, workspaces, members, currentUserId, myRole, onInvite, onRemoveMember, onSetRole, onTransferOwnership, onOpen, onNewWorkspace }: {
  tasks: Task[];
  workspace: string | null;
  workspaces: { id: string | null; name: string; ownerId?: string }[];
  members: WorkspaceMember[];
  currentUserId: string;
  myRole?: Role;
  onInvite: (workspaceId: string, email: string, role: Role) => void;
  onRemoveMember: (memberId: string) => void;
  onSetRole?: (memberId: string, role: Role) => void;
  onTransferOwnership?: (workspaceId: string, memberId: string) => void;
  onOpen?: (taskId: string) => void;
  onNewWorkspace: () => void;
}) {
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("member");
  const [selected, setSelected] = useState<WorkspaceMember | null>(null);
  const ws = workspaces.find((w) => w.id === workspace);
  const wsMembers = members.filter((m) => m.workspaceId === workspace);
  const active = wsMembers.filter((m) => m.status === "active");
  const invited = wsMembers.filter((m) => m.status === "invited");
  // fall back to owner if my row hasn't loaded but I own the workspace
  const role: Role | undefined = myRole ?? (ws?.ownerId === currentUserId ? "owner" : undefined);
  const canManage = can(role, "manageMembers");
  const inviteOptions = assignableRoles(role);

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
    onInvite(workspace, v, inviteRole);
    setEmail("");
  };

  const roleBadge = (m: WorkspaceMember) => m.status === "invited"
    ? <span className="mono" style={{ fontSize: 10, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase", padding: "2px 8px", borderRadius: 6, color: "var(--st-review)", background: "color-mix(in oklch, var(--st-review) 12%, transparent)" }}>Invited</span>
    : <span title={ROLE_META[m.role]?.blurb} className="mono" style={{ fontSize: 10, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase", padding: "2px 8px", borderRadius: 6, color: m.role === "owner" ? "var(--accent)" : "var(--ink-3)", background: "var(--surface-2)" }}>{ROLE_META[m.role]?.label}</span>;

  // clean, clickable card — opens the profile drawer
  const MemberCard = ({ m }: { m: WorkspaceMember }) => {
    const memberId = m.userId ?? "";
    const openN = tasks.filter((t) => t.assigneeId === memberId && t.status !== "done" && !t.archivedAt).length;
    const load = Math.min(100, openN * 20);
    const isSelf = m.userId === currentUserId;
    return (
      <button onClick={() => setSelected(m)} className="glass lift" style={{ padding: 16, borderRadius: 16, textAlign: "left", cursor: "pointer", border: "1px solid var(--hairline)", display: "flex", flexDirection: "column", gap: 13, width: "100%" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, width: "100%" }}>
          {m.userId ? <Avatar id={m.userId} size={40} /> : (
            <span style={{ width: 40, height: 40, borderRadius: 99, display: "grid", placeItems: "center", background: "var(--surface-2)", border: "1px dashed var(--hairline-strong)", color: "var(--ink-4)" }}><Icon name="user" size={18} /></span>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="truncate" style={{ fontSize: 14.5, fontWeight: 600 }}>{m.name || m.email}{isSelf && <span style={{ fontSize: 11, color: "var(--ink-4)", fontWeight: 400 }}> · you</span>}</div>
            <div className="truncate" style={{ fontSize: 12, color: "var(--ink-4)" }}>{m.email}</div>
          </div>
          {roleBadge(m)}
        </div>
        {m.status === "active" ? (
          <div style={{ width: "100%" }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, marginBottom: 6 }}>
              <span className="kicker">Workload</span>
              <span className="mono tnum" style={{ color: load > 60 ? "var(--prio-high)" : "var(--ink-3)" }}>{openN} open</span>
            </div>
            <div style={{ height: 6, borderRadius: 99, background: "var(--surface-2)", overflow: "hidden" }}>
              <div style={{ width: load + "%", height: "100%", borderRadius: 99, background: load > 60 ? "var(--prio-high)" : "var(--accent)", transition: "width .8s var(--ease)" }} />
            </div>
          </div>
        ) : (
          <p style={{ margin: 0, fontSize: 12.5, color: "var(--ink-4)", lineHeight: 1.5 }}>Will join when they sign in with this email.</p>
        )}
      </button>
    );
  };

  // slide-over profile — role controls + role-gated task list
  const MemberProfile = ({ m, onClose }: { m: WorkspaceMember; onClose: () => void }) => {
    const isSelf = m.userId === currentUserId;
    const memberId = m.userId ?? "";
    const assigned = tasks.filter((t) => t.assigneeId === memberId && !t.archivedAt);
    const openTasks = assigned.filter((t) => t.status !== "done").sort((a, b) => b.aiScore - a.aiScore);
    const doneN = assigned.length - openTasks.length;
    const canSeeTasks = can(role, "manageMembers") || isSelf;   // managers, or yourself
    const manageRole = m.status === "active" && !!onSetRole && canManageMember(role, m.role) && !isSelf;
    return (
      <>
        <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 70, background: "color-mix(in oklch, var(--bg-deep) 45%, transparent)", backdropFilter: "blur(2px)" }} />
        <div role="dialog" aria-modal="true" aria-label={`${m.name || m.email} profile`} className="anim-fadein" style={{ position: "fixed", top: 0, right: 0, bottom: 0, width: 420, maxWidth: "92vw", zIndex: 71, background: "var(--surface-raised)", borderLeft: "1px solid var(--hairline)", boxShadow: "var(--shadow-lg)", display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "18px 20px", borderBottom: "1px solid var(--hairline)" }}>
            {m.userId ? <Avatar id={m.userId} size={44} /> : <span style={{ width: 44, height: 44, borderRadius: 99, display: "grid", placeItems: "center", background: "var(--surface-2)", border: "1px dashed var(--hairline-strong)", color: "var(--ink-4)" }}><Icon name="user" size={20} /></span>}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="truncate" style={{ fontSize: 16, fontWeight: 600 }}>{m.name || m.email}{isSelf && <span style={{ fontSize: 12, color: "var(--ink-4)", fontWeight: 400 }}> · you</span>}</div>
              <div className="truncate" style={{ fontSize: 12.5, color: "var(--ink-4)" }}>{m.email}</div>
            </div>
            <button className="btn-icon" onClick={onClose} aria-label="Close" style={{ border: "none" }}><Icon name="x" size={18} /></button>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: 20, display: "flex", flexDirection: "column", gap: 18 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span className="kicker">Role</span>
              {manageRole ? (
                <select value={m.role} onChange={(e) => onSetRole!(m.id, e.target.value as Role)} aria-label="Role" style={{ height: 30, padding: "0 8px", borderRadius: 8, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-2)", fontFamily: "var(--font-display)", fontSize: 13, outline: "none", cursor: "pointer" }}>
                  {[...new Set<Role>([m.role, ...inviteOptions])].map((r) => <option key={r} value={r}>{ROLE_META[r].label}</option>)}
                </select>
              ) : roleBadge(m)}
              <span style={{ fontSize: 12, color: "var(--ink-4)" }}>{ROLE_META[m.role]?.blurb}</span>
            </div>

            {m.status === "active" && (
              <div style={{ display: "flex", gap: 24 }}>
                <div><div className="kicker">Open</div><div className="mono tnum" style={{ fontSize: 22, fontWeight: 600 }}>{openTasks.length}</div></div>
                <div><div className="kicker">Completed</div><div className="mono tnum" style={{ fontSize: 22, fontWeight: 600, color: "var(--st-done)" }}>{doneN}</div></div>
              </div>
            )}

            <div>
              <div className="kicker" style={{ marginBottom: 8 }}>{isSelf ? "Your tasks" : "Assigned tasks"}</div>
              {m.status !== "active" ? (
                <p style={{ fontSize: 13, color: "var(--ink-4)", margin: 0 }}>They haven't joined the workspace yet.</p>
              ) : !canSeeTasks ? (
                <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "12px 14px", borderRadius: 12, background: "var(--surface)", border: "1px solid var(--hairline)", color: "var(--ink-4)", fontSize: 12.5 }}>
                  <Icon name="lock" size={14} /> Only admins can view a teammate's tasks.
                </div>
              ) : openTasks.length === 0 ? (
                <p style={{ fontSize: 13, color: "var(--ink-4)", margin: 0 }}>No open tasks.</p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {openTasks.slice(0, 30).map((t) => {
                    const proj = getProject(t.projectId);
                    return (
                      <button key={t.id} onClick={() => { onOpen?.(t.id); onClose(); }} className="lift" style={{ display: "flex", alignItems: "center", gap: 9, padding: "8px 10px", borderRadius: 10, border: "1px solid var(--hairline)", background: "var(--surface)", cursor: "pointer", textAlign: "left" }}>
                        <StatusDot status={t.status} size={7} />
                        <span className="truncate" style={{ flex: 1, fontSize: 13, color: "var(--ink)" }}>{t.title}</span>
                        {proj && <span title={proj.name} style={{ width: 7, height: 7, borderRadius: 2, background: proj.color, flexShrink: 0 }} />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
              {m.status === "active" && role === "owner" && onTransferOwnership && workspace && m.role !== "owner" && (
                <button className="btn btn-ghost" onClick={() => { if (window.confirm(`Make ${m.name || m.email} the owner? You'll become an admin.`)) { onTransferOwnership(workspace, m.id); onClose(); } }} style={{ justifyContent: "center" }}><Icon name="target" size={15} /> Make owner</button>
              )}
              {((canManageMember(role, m.role) && !isSelf) || (isSelf && m.role !== "owner")) && (
                <button className="btn btn-ghost" onClick={() => { if (window.confirm(isSelf ? "Leave this workspace?" : `Remove ${m.name || m.email} from this workspace?`)) { onRemoveMember(m.id); onClose(); } }} style={{ justifyContent: "center", color: "var(--prio-urgent)" }}><Icon name="x" size={15} /> {isSelf ? "Leave workspace" : "Remove from workspace"}</button>
              )}
            </div>
          </div>
        </div>
      </>
    );
  };

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px 40px" }}>
      {/* invite */}
      {canManage && (
        <div className="glass" style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 16px", borderRadius: 16, marginBottom: 24, flexWrap: "wrap" }}>
          <Icon name="users" size={17} style={{ color: "var(--accent)" }} />
          <span style={{ fontSize: 13.5, fontWeight: 600 }}>Invite to {ws?.name}</span>
          <input value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submitInvite(); }}
            type="email" placeholder="teammate@company.com" aria-label="Invite email"
            style={{ flex: 1, minWidth: 180, height: 38, padding: "0 13px", borderRadius: 10, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 13.5, outline: "none" }} />
          <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as Role)} aria-label="Invite as role"
            style={{ height: 38, padding: "0 9px", borderRadius: 10, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-2)", fontFamily: "var(--font-display)", fontSize: 13, outline: "none", cursor: "pointer" }}>
            {inviteOptions.map((r) => <option key={r} value={r}>{ROLE_META[r].label}</option>)}
          </select>
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

      {selected && (() => {
        const live = wsMembers.find((x) => x.id === selected.id);
        return live ? <MemberProfile m={live} onClose={() => setSelected(null)} /> : null;
      })()}
    </div>
  );
}
