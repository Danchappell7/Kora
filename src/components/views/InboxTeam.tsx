/* ============================================================
   KORA — Inbox (real activity feed) & Team views
   ============================================================ */
import { Icon, Avatar, Tag } from "../primitives";
import { MEMBERS, timeAgo } from "../../data/data";
import { isSupabaseConfigured } from "../../lib/supabase";
import type { Task, Member, Activity, ActivityKind, IconName } from "../../data/types";

const KIND_META: Record<ActivityKind, { icon: IconName; color: string; verb: string }> = {
  created:   { icon: "plus",    color: "var(--accent)",     verb: "created" },
  status:    { icon: "refresh", color: "var(--st-progress)", verb: "updated" },
  completed: { icon: "check",   color: "var(--st-done)",    verb: "completed" },
  reopened:  { icon: "refresh", color: "var(--st-review)",  verb: "reopened" },
  comment:   { icon: "message", color: "var(--accent)",     verb: "commented on" },
  deleted:   { icon: "trash",   color: "var(--st-blocked)", verb: "deleted" },
};

export function InboxView({ activity, tasks, onOpen }: { activity: Activity[]; tasks: Task[]; onOpen: (id: string) => void }) {
  if (activity.length === 0) {
    return (
      <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px 40px", display: "grid", placeItems: "center" }}>
        <div style={{ textAlign: "center", color: "var(--ink-4)", maxWidth: 420 }}>
          <div style={{ display: "inline-flex", padding: 14, borderRadius: 16, background: "var(--surface)", border: "1px solid var(--hairline)", marginBottom: 14 }}><Icon name="inbox" size={24} style={{ color: "var(--ink-4)" }} /></div>
          <p style={{ fontSize: 14.5, color: "var(--ink-2)", margin: 0, fontWeight: 600 }}>You're all caught up</p>
          <p style={{ fontSize: 13, margin: "5px 0 0", lineHeight: 1.5 }}>Activity on your tasks — creates, completions, comments — will show up here.</p>
        </div>
      </div>
    );
  }
  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px 40px", maxWidth: 760, width: "100%", margin: "0 auto" }}>
      <div className="glass" style={{ borderRadius: 16, overflow: "hidden" }}>
        {activity.map((a, i) => {
          const meta = KIND_META[a.kind] ?? KIND_META.status;
          const taskStillExists = a.taskId && tasks.some((t) => t.id === a.taskId);
          return (
            <button key={a.id} onClick={() => taskStillExists && onOpen(a.taskId!)} style={{
              display: "flex", alignItems: "center", gap: 13, width: "100%", padding: "13px 18px", textAlign: "left",
              border: "none", borderTop: i ? "1px solid var(--hairline)" : "none", background: "transparent", transition: "background .14s",
              cursor: taskStillExists ? "pointer" : "default",
            }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-2)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
              <span style={{ display: "grid", placeItems: "center", width: 32, height: 32, borderRadius: 99, flexShrink: 0, background: `color-mix(in oklch, ${meta.color} 14%, transparent)`, color: meta.color }}>
                <Icon name={meta.icon} size={15} />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="truncate" style={{ fontSize: 13.5, color: "var(--ink-2)" }}>
                  You {meta.verb} <strong style={{ color: "var(--ink)" }}>{a.taskTitle}</strong>
                </div>
                <div className="truncate" style={{ fontSize: 12, color: "var(--ink-4)", marginTop: 2 }}>
                  {a.kind === "comment" ? `“${a.detail}”` : a.detail}
                </div>
              </div>
              <span className="mono" style={{ fontSize: 11, color: "var(--ink-4)", flexShrink: 0 }}>{timeAgo(a.createdAt)}</span>
              {taskStillExists && <Icon name="chevronRight" size={16} style={{ color: "var(--ink-4)" }} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function TeamView({ tasks }: { tasks: Task[] }) {
  const team = MEMBERS.filter((m) => m.type !== "external");
  const ext = MEMBERS.filter((m) => m.type === "external");
  const hasTeammates = MEMBERS.some((m) => m.type !== "self");

  // Real accounts have no teammates yet — show onboarding instead of demo people.
  if (isSupabaseConfigured && !hasTeammates) {
    return (
      <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px 40px", display: "grid", placeItems: "center" }}>
        <div style={{ textAlign: "center", color: "var(--ink-4)", maxWidth: 440 }}>
          <div style={{ display: "inline-flex", padding: 14, borderRadius: 16, background: "var(--surface)", border: "1px solid var(--hairline)", marginBottom: 14 }}><Icon name="users" size={24} style={{ color: "var(--ink-4)" }} /></div>
          <p style={{ fontSize: 14.5, color: "var(--ink-2)", margin: 0, fontWeight: 600 }}>It's just you for now</p>
          <p style={{ fontSize: 13, margin: "5px 0 0", lineHeight: 1.5 }}>Workspaces and teammate invites are coming — for now Kora is tuned for your own focus and planning.</p>
        </div>
      </div>
    );
  }
  const Card = ({ m }: { m: Member }) => {
    const assigned = tasks.filter((t) => t.assigneeId === m.id);
    const openN = assigned.filter((t) => t.status !== "done").length;
    const load = Math.min(100, openN * 25);
    return (
      <div className="glass" style={{ padding: 18, borderRadius: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
          <Avatar id={m.id} size={42} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14.5, fontWeight: 600 }}>{m.name}{m.type === "self" && <span style={{ fontSize: 11, color: "var(--ink-4)", fontWeight: 400 }}> · you</span>}</div>
            <div className="truncate" style={{ fontSize: 12, color: "var(--ink-4)" }}>{m.email}</div>
          </div>
          {m.type === "external" && <Tag id="ops" small />}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, marginBottom: 7 }}>
          <span className="kicker">Workload</span>
          <span className="mono tnum" style={{ color: load > 60 ? "var(--prio-high)" : "var(--ink-3)" }}>{openN} open</span>
        </div>
        <div style={{ height: 6, borderRadius: 99, background: "var(--surface-2)", overflow: "hidden" }}>
          <div style={{ width: load + "%", height: "100%", borderRadius: 99, background: load > 60 ? "var(--prio-high)" : "var(--accent)", transition: "width .8s var(--ease)" }} />
        </div>
      </div>
    );
  };
  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px 40px" }}>
      <div className="kicker" style={{ marginBottom: 12 }}>Members</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(280px,1fr))", gap: 14, marginBottom: 28 }}>
        {team.map((m) => <Card key={m.id} m={m} />)}
      </div>
      <div className="kicker" style={{ marginBottom: 12 }}>External collaborators</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(280px,1fr))", gap: 14 }}>
        {ext.map((m) => <Card key={m.id} m={m} />)}
      </div>
    </div>
  );
}
