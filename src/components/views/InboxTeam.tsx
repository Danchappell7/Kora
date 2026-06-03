/* ============================================================
   KORA — Inbox & Team views
   ============================================================ */
import { Icon, Avatar, Tag } from "../primitives";
import { getMember, MEMBERS } from "../../data/data";
import { isSupabaseConfigured } from "../../lib/supabase";
import type { Task, Member, IconName } from "../../data/types";

interface InboxItem {
  id: string; who: string; action: string; target: string; time: string; unread: boolean; icon: IconName; ai?: boolean;
}

const INBOX: InboxItem[] = [
  { id: "n1", who: "m-1", action: "assigned you", target: "Ship onboarding redesign to staging", time: "12m", unread: true, icon: "tasks" },
  { id: "n2", who: "m-3", action: "mentioned you in", target: "Define design tokens v2", time: "1h", unread: true, icon: "message" },
  { id: "n3", who: "m-self", action: "AI flagged a risk on", target: "Migrate auth to edge sessions", time: "2h", unread: true, icon: "sparkles", ai: true },
  { id: "n4", who: "m-2", action: "completed", target: "Audit landing-page performance", time: "5h", unread: false, icon: "check" },
  { id: "n5", who: "m-4", action: "commented on", target: "Interview 5 churned users", time: "1d", unread: false, icon: "message" },
];

export function InboxView({ tasks, onOpen }: { tasks: Task[]; onOpen: (id: string) => void }) {
  // No notifications backend yet — real accounts start with an empty inbox.
  const items = isSupabaseConfigured ? [] : INBOX;
  if (items.length === 0) {
    return (
      <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px 40px", display: "grid", placeItems: "center" }}>
        <div style={{ textAlign: "center", color: "var(--ink-4)", maxWidth: 420 }}>
          <div style={{ display: "inline-flex", padding: 14, borderRadius: 16, background: "var(--surface)", border: "1px solid var(--hairline)", marginBottom: 14 }}><Icon name="inbox" size={24} style={{ color: "var(--ink-4)" }} /></div>
          <p style={{ fontSize: 14.5, color: "var(--ink-2)", margin: 0, fontWeight: 600 }}>You're all caught up</p>
          <p style={{ fontSize: 13, margin: "5px 0 0", lineHeight: 1.5 }}>Mentions, assignments, and updates will show up here as your team starts collaborating.</p>
        </div>
      </div>
    );
  }
  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px 40px", maxWidth: 760, width: "100%", margin: "0 auto" }}>
      <div className="glass" style={{ borderRadius: 16, overflow: "hidden" }}>
        {INBOX.map((n, i) => {
          const m = getMember(n.who);
          const t = tasks.find((x) => x.title === n.target);
          return (
            <button key={n.id} onClick={() => t && onOpen(t.id)} style={{
              display: "flex", alignItems: "center", gap: 13, width: "100%", padding: "14px 18px", cursor: "pointer", textAlign: "left",
              border: "none", borderTop: i ? "1px solid var(--hairline)" : "none",
              background: n.unread ? "color-mix(in oklch, var(--accent) 4%, transparent)" : "transparent", transition: "background .14s",
            }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-2)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = n.unread ? "color-mix(in oklch, var(--accent) 4%, transparent)" : "transparent")}>
              <span style={{ position: "relative" }}>
                {n.ai ? <span style={{ display: "grid", placeItems: "center", width: 32, height: 32, borderRadius: 99, background: "var(--accent-dim)", color: "var(--accent)" }}><Icon name="sparkles" size={16} /></span> : <Avatar id={n.who} size={32} />}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, color: "var(--ink-2)" }}>
                  <strong style={{ color: "var(--ink)" }}>{n.ai ? "Kora AI" : m?.name}</strong> {n.action} <span style={{ color: "var(--ink)" }}>{n.target}</span>
                </div>
                <div className="mono" style={{ fontSize: 11, color: "var(--ink-4)", marginTop: 3 }}>{n.time} ago</div>
              </div>
              {n.unread && <span style={{ width: 7, height: 7, borderRadius: 99, background: "var(--accent)", boxShadow: "0 0 6px var(--accent)", flexShrink: 0 }} />}
              <Icon name="chevronRight" size={16} style={{ color: "var(--ink-4)" }} />
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
