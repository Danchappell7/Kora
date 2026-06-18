/* ============================================================
   KANBO — Sidebar (nav, workspace switcher, projects, deep-work mini)
   ============================================================ */
import { useState } from "react";
import { Icon, Avatar, KanboLogo } from "./primitives";
import { trialDaysLeft, BILLING_ENABLED } from "./Billing";
import type { Task, Project, Member, Workspace, Subscription, IconName } from "../data/types";
import type { Route } from "../app-types";
import type { FocusTimer } from "../hooks/useFocusTimer";

function DeepWorkMini({ focus, onOpen }: { focus: FocusTimer; onOpen: () => void }) {
  const { running, seconds } = focus;
  const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");
  return (
    <div className="glass" style={{ margin: "4px 12px 0", padding: 13, borderRadius: 14, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 9 }}>
        <Icon name="clock" size={13} style={{ color: "var(--accent)" }} />
        <span className="kicker" style={{ color: "var(--ink-3)" }}>Deep Work</span>
        {running && <span style={{ marginLeft: "auto", width: 6, height: 6, borderRadius: 99, background: "var(--accent)", boxShadow: "0 0 8px var(--accent)", animation: "pulseGlow 1.6s infinite" }} />}
      </div>
      <div className="mono tnum" style={{ fontSize: 30, fontWeight: 500, letterSpacing: "-0.02em", lineHeight: 1, color: running ? "var(--accent)" : "var(--ink)" }}>
        {mm}:{ss}
      </div>
      <button className="btn btn-accent" onClick={onOpen} style={{ width: "100%", justifyContent: "center", marginTop: 11 }}>
        <Icon name={running ? "arrowUpRight" : "play"} size={15} fill={running ? "none" : "currentColor"} />
        {running ? "Open focus" : "Start focus"}
      </button>
    </div>
  );
}

function NavItem({ icon, label, active, badge, onClick }: {
  icon: IconName; label: string; active?: boolean; badge?: number; onClick?: () => void;
}) {
  return (
    <button onClick={onClick} className="knav" data-active={active}>
      {active && <span style={{ position: "absolute", left: -12, top: "50%", transform: "translateY(-50%)", width: 3, height: 18, borderRadius: 99, background: "var(--accent)", boxShadow: "0 0 10px var(--accent)" }} />}
      <Icon name={icon} size={18} style={{ color: active ? "var(--accent)" : "currentColor", opacity: active ? 1 : 0.85 }} />
      <span style={{ flex: 1 }}>{label}</span>
      {badge != null && badge > 0 && (
        <span className="mono tnum" style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-3)", background: "var(--surface-2)", borderRadius: 6, padding: "1px 7px" }}>{badge}</span>
      )}
    </button>
  );
}

export function Sidebar({ route, setRoute, workspace, setWorkspace, workspaces, focus, openFocus, tasks, projects, inboxCount, currentUserId, currentUser, onSignOut, onOpenSettings, onNewProject, onDeleteProject, onNewWorkspace, subscription, onUpgrade, onManageBilling }: {
  route: Route;
  setRoute: (r: Route) => void;
  workspace: string | null;
  setWorkspace: (id: string | null) => void;
  workspaces: Workspace[];
  onNewWorkspace: () => void;
  focus: FocusTimer;
  openFocus: () => void;
  tasks: Task[];
  projects: Project[];
  inboxCount: number;
  currentUserId: string;
  currentUser?: Member;
  onSignOut?: () => void;
  onOpenSettings?: () => void;
  onNewProject: () => void;
  onDeleteProject: (id: string) => void;
  subscription?: Subscription | null;
  onUpgrade: () => void;
  onManageBilling: () => void;
}) {
  const [wsOpen, setWsOpen] = useState(false);
  const visibleProjects = projects.filter((p) => (p.workspaceId ?? null) === workspace);
  const activeWs = workspaces.find((w) => w.id === workspace) || workspaces[0] || { id: null, name: "Personal", kind: "personal" as const };
  const myOpen = tasks.filter((t) => t.assigneeId === currentUserId && t.status !== "done").length;

  const nav: { id: Route["view"]; icon: IconName; label: string; badge?: number }[] = [
    { id: "plan", icon: "calendarPlus", label: "Plan my day" },
    { id: "home", icon: "home", label: "Home" },
    { id: "inbox", icon: "inbox", label: "Inbox", badge: inboxCount },
    { id: "tasks", icon: "tasks", label: "My tasks", badge: myOpen },
    { id: "calendar", icon: "calendar", label: "Calendar" },
    { id: "search", icon: "search", label: "Search" },
    { id: "team", icon: "users", label: "Team" },
    { id: "analytics", icon: "chart", label: "Analytics" },
  ];

  return (
    <aside style={{
      width: 252, flexShrink: 0, height: "100%", display: "flex", flexDirection: "column",
      borderRight: "1px solid var(--hairline)", background: "color-mix(in oklch, var(--bg-deep) 70%, transparent)",
      backdropFilter: "blur(12px)", position: "relative", zIndex: 5,
    }}>
      {/* brand + workspace */}
      <div style={{ padding: "16px 16px 10px" }}>
        <button onClick={() => setWsOpen((v) => !v)} style={{
          display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "7px 8px",
          borderRadius: 11, border: "1px solid var(--hairline)", background: "var(--surface)", cursor: "pointer",
        }}>
          <KanboLogo size={26} />
          <span style={{ flex: 1, textAlign: "left", minWidth: 0 }}>
            <span style={{ display: "block", fontFamily: "var(--font-head)", fontWeight: 600, fontSize: 14, letterSpacing: "0.15em", textTransform: "uppercase" }}>Kanbo</span>
            <span className="truncate" style={{ display: "block", fontSize: 11, color: "var(--ink-4)" }}>{activeWs.name}</span>
          </span>
          <Icon name="chevronDown" size={15} style={{ color: "var(--ink-4)", transform: wsOpen ? "rotate(180deg)" : "none", transition: "transform .2s" }} />
        </button>
        {wsOpen && (
          <div className="glass anim-scalein" style={{ padding: 6, marginTop: 6, borderRadius: 12 }}>
            <div className="kicker" style={{ padding: "5px 8px 6px" }}>Workspaces</div>
            {workspaces.map((w) => (
              <button key={w.id ?? "personal"} onClick={() => { setWorkspace(w.id); setWsOpen(false); }} style={{
                display: "flex", alignItems: "center", gap: 9, width: "100%", padding: "7px 8px", borderRadius: 8,
                border: "none", cursor: "pointer", fontSize: 13.5, fontFamily: "var(--font-display)", textAlign: "left",
                color: w.id === workspace ? "var(--ink)" : "var(--ink-3)", background: w.id === workspace ? "var(--surface-2)" : "transparent",
              }}>
                <Icon name={w.kind === "personal" ? "user" : "briefcase"} size={15} style={{ color: w.id === workspace ? "var(--accent)" : "currentColor" }} />
                <span style={{ flex: 1 }}>{w.name}</span>
                {w.id === workspace && <Icon name="check" size={14} style={{ color: "var(--accent)" }} />}
              </button>
            ))}
            <div className="divider" style={{ margin: "6px 4px" }} />
            <button onClick={() => { setWsOpen(false); onNewWorkspace(); }} style={{ display: "flex", alignItems: "center", gap: 9, width: "100%", padding: "7px 8px", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 13.5, color: "var(--ink-3)", background: "transparent", fontFamily: "var(--font-display)" }}>
              <Icon name="plus" size={15} /> New workspace
            </button>
          </div>
        )}
      </div>

      {/* nav */}
      <nav style={{ padding: "4px 12px", display: "flex", flexDirection: "column", gap: 2 }}>
        {nav.map((n) => <NavItem key={n.id} icon={n.icon} label={n.label} badge={n.badge} active={route.view === n.id} onClick={() => setRoute({ view: n.id })} />)}
      </nav>

      <DeepWorkMini focus={focus} onOpen={openFocus} />

      {/* projects */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px 18px 6px" }}>
        <span className="kicker">Projects</span>
        <button onClick={onNewProject} className="btn-icon" style={{ width: 24, height: 24, border: "none" }} title="New project"><Icon name="plus" size={15} /></button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "0 12px 12px", display: "flex", flexDirection: "column", gap: 1 }}>
        {visibleProjects.length === 0 && <p style={{ fontSize: 12.5, color: "var(--ink-4)", padding: "6px 11px" }}>No projects here yet.</p>}
        {visibleProjects.map((p) => {
          const active = route.view === "project" && route.projectId === p.id;
          const count = tasks.filter((t) => t.projectId === p.id && t.status !== "done").length;
          const deletable = p.id !== "p-personal";
          return (
            <div key={p.id} className="kproj-row" style={{ position: "relative", display: "flex", alignItems: "center" }}>
              <button onClick={() => setRoute({ view: "project", projectId: p.id })} className="kproj" data-active={active} style={{ flex: 1 }}>
                <span style={{ width: 9, height: 9, borderRadius: 3, background: p.color, flexShrink: 0, boxShadow: `0 0 8px color-mix(in oklch, ${p.color} 60%, transparent)` }} />
                <span className="truncate" style={{ flex: 1 }}>{p.name}</span>
                {count > 0 && <span className="mono tnum kproj-count" style={{ fontSize: 11, color: "var(--ink-4)" }}>{count}</span>}
              </button>
              {deletable && (
                <button className="kproj-del" title="Delete project"
                  onClick={(e) => { e.stopPropagation(); onDeleteProject(p.id); }}>
                  <Icon name="trash" size={14} />
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* billing */}
      {BILLING_ENABLED && subscription && (
        <button onClick={subscription.status === "active" ? onManageBilling : onUpgrade}
          style={{ display: "flex", alignItems: "center", gap: 9, margin: "0 12px 4px", padding: "8px 11px", borderRadius: 10, cursor: "pointer", textAlign: "left", border: "1px solid var(--hairline)", background: subscription.status === "trialing" ? "var(--accent-dim)" : "var(--surface)", fontFamily: "var(--font-display)" }}>
          <Icon name="sparkles" size={15} style={{ color: "var(--accent)", flexShrink: 0 }} />
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: "block", fontSize: 12.5, fontWeight: 500, color: "var(--ink-2)" }}>
              {subscription.status === "active" ? (subscription.plan === "team" ? "Team plan" : "Personal plan")
                : subscription.status === "trialing" ? "Free trial" : "Inactive"}
            </span>
            <span style={{ display: "block", fontSize: 11, color: "var(--ink-4)" }}>
              {subscription.status === "active" ? "Manage billing"
                : subscription.status === "trialing" ? `${trialDaysLeft(subscription)} day${trialDaysLeft(subscription) === 1 ? "" : "s"} left · Upgrade` : "Reactivate"}
            </span>
          </span>
        </button>
      )}

      {/* user */}
      <div style={{ padding: 12, borderTop: "1px solid var(--hairline)", display: "flex", alignItems: "center", gap: 10 }}>
        <button onClick={onOpenSettings} title="Edit your profile" aria-label="Edit your profile"
          style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0, padding: "4px 6px", margin: "-4px -6px", borderRadius: 10, border: "none", background: "transparent", cursor: onOpenSettings ? "pointer" : "default", textAlign: "left", fontFamily: "var(--font-display)" }}>
          <Avatar id={currentUserId} size={32} />
          <span style={{ flex: 1, minWidth: 0 }}>
            <span className="truncate" style={{ display: "block", fontSize: 13, fontWeight: 500 }}>
              {currentUser?.name || "You"}
              {currentUser?.pronouns && <span style={{ fontSize: 11, fontWeight: 400, color: "var(--ink-4)" }}> · {currentUser.pronouns}</span>}
            </span>
            <span className="truncate" style={{ display: "block", fontSize: 11, color: "var(--ink-4)" }}>{currentUser?.email || ""}</span>
          </span>
        </button>
        {onOpenSettings && <button className="btn-icon" onClick={onOpenSettings} style={{ border: "none", width: 28, height: 28 }} title="Settings"><Icon name="settings" size={16} /></button>}
        {onSignOut && <button className="btn-icon" onClick={onSignOut} style={{ border: "none", width: 28, height: 28 }} title="Sign out"><Icon name="logout" size={16} /></button>}
      </div>
    </aside>
  );
}
