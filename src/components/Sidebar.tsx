/* ============================================================
   KANBO — Sidebar (nav, workspace switcher, projects, deep-work mini)
   ============================================================ */
import { useState, useMemo, useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import { Icon, Avatar, KanboLogo, Collapse } from "./primitives";
import { trialDaysLeft, BILLING_ENABLED } from "./Billing";
import { useToast } from "./Toast";
import type { Task, Project, Member, Workspace, Subscription, IconName, SavedSearch, Role } from "../data/types";
import type { Route } from "../app-types";
import { SMART_LISTS } from "../lib/smartLists";
import { canDeleteProject, canArchiveProject } from "../lib/permissions";
import type { FocusTimer } from "../hooks/useFocusTimer";

/* Sidebar-only rules: project row action group, saved-list delete reveal and
   the skip link. Kept beside the component so the row layout lives in one
   place. Hover-revealed controls also appear on keyboard focus and are always
   visible on touch screens. */
const SIDEBAR_CSS = `
.kskip:not(:focus) { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.kskip:focus { position: absolute; left: 12px; top: 10px; z-index: 30; padding: 9px 13px; border-radius: 10px; background: var(--surface-raised); color: var(--ink); box-shadow: var(--shadow-lg); font: 600 13px var(--font-display); text-decoration: none; }
main[tabindex="-1"]:focus { outline: none; }

.kproj-item { position: relative; display: flex; align-items: center; border-radius: 9px; }
.kproj-item > .kproj { flex: 1; min-width: 0; }
.kproj-item:hover > .kproj, .kproj-item:focus-within > .kproj { padding-right: var(--kacts, 86px); }
/* keep the row highlighted while the pointer is on its actions */
.kproj-item:hover > .kproj:not([data-active="true"]) { background: var(--surface); }
[data-theme="light"] .kproj-item:hover > .kproj:not([data-active="true"]) { background: oklch(0.28 0.02 266 / 0.045); }
.kproj-pinmark { display: inline-flex; color: var(--accent); flex-shrink: 0; }
.kproj-item:hover .kproj-n, .kproj-item:focus-within .kproj-n,
.kproj-item:hover .kproj-pinmark, .kproj-item:focus-within .kproj-pinmark { visibility: hidden; }
.kproj-acts { position: absolute; right: 5px; top: 50%; transform: translateY(-50%); display: flex; align-items: center; gap: 1px; opacity: 0; pointer-events: none; transition: opacity .14s var(--ease); }
.kproj-item:hover .kproj-acts, .kproj-item:focus-within .kproj-acts { opacity: 1; pointer-events: auto; }
.kproj-act { display: grid; place-items: center; width: 24px; height: 24px; padding: 0; border: none; border-radius: 7px; background: transparent; color: var(--ink-3); cursor: pointer; transition: color .14s, background .14s; }
.kproj-act:hover { color: var(--ink); background: var(--fill-2, color-mix(in oklch, var(--ink) 8%, transparent)); }
.kproj-act[data-on="true"] { color: var(--accent); }
.kproj-act[data-kind="delete"]:hover { color: var(--st-blocked); background: color-mix(in oklch, var(--st-blocked) 14%, transparent); }

.ksaved-row:focus-within .ksaved-del { opacity: 1; }
.ksaved-row:hover .knav-badge, .ksaved-row:focus-within .knav-badge { visibility: hidden; }

@media (hover: none), (pointer: coarse) {
  /* no hover on touch: the actions sit in the row, always reachable */
  .kproj-acts { position: static; transform: none; opacity: 1; pointer-events: auto; padding-right: 2px; }
  .kproj-item:hover > .kproj, .kproj-item:focus-within > .kproj { padding-right: 11px; }
  .kproj-item .kproj-n, .kproj-item .kproj-pinmark { display: none; }
  .kproj-act { width: 32px; height: 32px; }
  .ksaved-del { opacity: 1; }
  .ksaved-row .knav-badge { visibility: hidden; }
}
`;

function StarGlyph({ filled, size = 14 }: { filled?: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false"
      fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth={2} strokeLinejoin="round">
      <path d="M12 3.6l2.55 5.2 5.75.84-4.16 4.05.98 5.72L12 16.72l-5.12 2.69.98-5.72-4.16-4.05 5.75-.84z" />
    </svg>
  );
}

/** Focus the element with this id, or the first <main>, for the skip link. */
function focusMain(): boolean {
  const m = (document.getElementById("main") ?? document.querySelector("main")) as HTMLElement | null;
  if (!m) return false;
  if (!m.hasAttribute("tabindex")) m.setAttribute("tabindex", "-1");
  m.focus();
  return true;
}

function DeepWorkMini({ focus, onOpen }: { focus: FocusTimer; onOpen: () => void }) {
  const { running, setRunning, seconds, endSession, focusMinToday } = focus;
  const [flash, setFlash] = useState<string | null>(null);
  const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");
  const hasElapsed = seconds > 0;
  const todayLabel = focusMinToday > 0 ? `${Math.floor(focusMinToday / 60) ? `${Math.floor(focusMinToday / 60)}h ` : ""}${focusMinToday % 60}m banked today` : "Bank focused time as you work";
  const end = () => { const m = endSession(); setFlash(m > 0 ? `Banked ${m}m of deep work` : "Too short to bank"); window.setTimeout(() => setFlash(null), 2600); };
  return (
    <div className="glass" style={{ margin: "4px 12px 0", padding: 13, borderRadius: 14, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 9 }}>
        <Icon name="clock" size={13} style={{ color: "var(--accent)" }} />
        <span className="kicker" style={{ color: "var(--ink-3)" }}>Deep Work</span>
        {running && <span style={{ width: 6, height: 6, borderRadius: 99, background: "var(--accent)", boxShadow: "0 0 8px var(--accent)", animation: "pulseGlow 1.6s infinite" }} />}
        <button onClick={onOpen} className="btn-icon" title="Open focus mode" aria-label="Open focus mode" style={{ marginLeft: "auto", width: 22, height: 22, border: "none", color: "var(--ink-4)" }}><Icon name="arrowUpRight" size={14} /></button>
      </div>
      <div className="mono tnum" style={{ fontSize: 30, fontWeight: 500, letterSpacing: "-0.02em", lineHeight: 1, color: running ? "var(--accent)" : "var(--ink)" }}>
        {mm}:{ss}
      </div>
      <div className="truncate" style={{ minHeight: 14, marginTop: 5, fontSize: 11, color: flash ? "var(--accent)" : "var(--ink-4)", fontWeight: flash ? 600 : 400 }}>{flash || todayLabel}</div>
      {!running && !hasElapsed ? (
        <button className="btn btn-accent" onClick={() => setRunning(true)} style={{ width: "100%", justifyContent: "center", marginTop: 9 }}>
          <Icon name="play" size={15} fill="currentColor" /> Start focus
        </button>
      ) : (
        <div style={{ display: "flex", gap: 7, marginTop: 9 }}>
          <button className="btn btn-accent" onClick={() => setRunning((v) => !v)} style={{ flex: 1, justifyContent: "center" }}>
            <Icon name={running ? "pause" : "play"} size={15} fill="currentColor" /> {running ? "Pause" : "Resume"}
          </button>
          <button className="btn btn-ghost" onClick={end} title="Stop and bank this session" style={{ justifyContent: "center" }}>
            <Icon name="check" size={15} /> End
          </button>
        </div>
      )}
    </div>
  );
}

function NavItem({ icon, label, active, badge, onClick }: {
  icon: IconName; label: string; active?: boolean; badge?: number; onClick?: () => void;
}) {
  return (
    <button onClick={onClick} className="knav" data-active={active} aria-current={active ? "page" : undefined}>
      {active && <span style={{ position: "absolute", left: -12, top: "50%", transform: "translateY(-50%)", width: 3, height: 18, borderRadius: 99, background: "var(--accent)", boxShadow: "0 0 10px var(--accent)" }} />}
      <Icon name={icon} size={18} style={{ color: active ? "var(--accent)" : "currentColor", opacity: active ? 1 : 0.85 }} />
      <span style={{ flex: 1 }}>{label}</span>
      {badge != null && badge > 0 && (
        <span className="mono tnum knav-badge" style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-3)", background: "var(--surface-2)", borderRadius: 6, padding: "1px 7px" }}>{badge}</span>
      )}
    </button>
  );
}

export function Sidebar({ route, setRoute, workspace, setWorkspace, workspaces, focus, openFocus, tasks, projects, inboxCount, currentUserId, currentUser, onSignOut, onOpenSettings, onNewProject, onDeleteProject, onArchiveProject, onRestoreProject, onNewWorkspace, subscription, onUpgrade, onManageBilling, smartCounts, savedSearches = [], savedSearchCounts, onDeleteSavedSearch, myRole, guardRoute = true }: {
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
  onArchiveProject?: (id: string) => void;
  onRestoreProject?: (id: string) => void;
  subscription?: Subscription | null;
  onUpgrade: () => void;
  onManageBilling: () => void;
  smartCounts?: Record<string, number>;
  savedSearches?: SavedSearch[];
  savedSearchCounts?: Record<string, number>;
  /** may return a promise — a rejection shows an error toast and brings the list back */
  onDeleteSavedSearch?: (id: string) => void | Promise<unknown>;
  /** the caller's role in the active workspace; gates project archive/delete (mirrors 0041) */
  myRole?: Role | null;
  /**
   * The Sidebar keeps the open project valid: it follows a project opened from
   * another workspace (palette, search) by switching to that workspace, and
   * leaves a project that was archived, deleted or left behind by a workspace
   * change. Pass false only if App takes over that job — never run both, or
   * every redirect fires (and toasts) twice.
   */
  guardRoute?: boolean;
}) {
  const toast = useToast();
  const [wsOpen, setWsOpen] = useState(false);
  const wsBtnRef = useRef<HTMLButtonElement>(null);
  const [pinned, setPinned] = useState<Set<string>>(() => { try { return new Set(JSON.parse(localStorage.getItem("kanbo-pinned-projects") || "[]")); } catch { return new Set(); } });
  const togglePin = (id: string) => setPinned((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); try { localStorage.setItem("kanbo-pinned-projects", JSON.stringify([...n])); } catch { /* private mode */ } return n; });
  const [archivedOpen, setArchivedOpen] = useState(false);
  const visibleProjects = projects.filter((p) => (p.workspaceId ?? null) === workspace && !p.archivedAt);
  const archivedProjects = projects.filter((p) => (p.workspaceId ?? null) === workspace && p.archivedAt);
  // pinned projects float to the top (stable within each group)
  const orderedProjects = [...visibleProjects].sort((a, b) => (pinned.has(b.id) ? 1 : 0) - (pinned.has(a.id) ? 1 : 0));
  const activeWs: Workspace = workspaces.find((w) => w.id === workspace) || workspaces[0] || { id: null, name: "Personal", kind: "personal" };
  // Badges count what the matching page shows as rows: open tasks, with a
  // sub-task counted only when its parent isn't in the same list (otherwise
  // it nests under the parent). "Mine" = assignee OR collaborator, exactly
  // like the My tasks view. One O(n) pass; the memo only pays off when the
  // caller passes a stable `tasks` array (App currently rebuilds it per render).
  const { projectOpen, myOpen } = useMemo(() => {
    const idsByProject = new Map<string, Set<string>>();
    const mineIds = new Set<string>();
    for (const t of tasks) {
      let set = idsByProject.get(t.projectId);
      if (!set) idsByProject.set(t.projectId, (set = new Set()));
      set.add(t.id);
      if (t.assigneeId === currentUserId || (t.collaborators ?? []).includes(currentUserId)) mineIds.add(t.id);
    }
    const perProject = new Map<string, number>();
    let mine = 0;
    for (const t of tasks) {
      if (t.status === "done" || t.archivedAt) continue;
      if (!t.parentId || !idsByProject.get(t.projectId)?.has(t.parentId)) perProject.set(t.projectId, (perProject.get(t.projectId) ?? 0) + 1);
      if (mineIds.has(t.id) && (!t.parentId || !mineIds.has(t.parentId))) mine += 1;
    }
    return { projectOpen: perProject, myOpen: mine };
  }, [tasks, currentUserId]);
  // delete follows 0041's DELETE policy (owner/admin/project owner); archive and
  // restore are plain updates any writer may make, so members can undo their own archive
  const canDelete = (p: Project) => canDeleteProject(p, { currentUserId, myRole, workspaceOwnerId: activeWs.ownerId });
  const canArchive = (p: Project) => canArchiveProject(p, { myRole });

  // switching workspace never strands you on a project from the old one
  // (its header would read "0 tasks" and quick-add would file into it)
  const switchWorkspace = (id: string | null) => {
    setWsOpen(false);
    if (id === workspace) return;
    setWorkspace(id);
    if (route.view === "project") {
      const p = projects.find((x) => x.id === route.projectId);
      if (!p || (p.workspaceId ?? null) !== id) setRoute({ view: "home" });
    }
  };

  // …and neither does a teammate archiving or deleting the project you're in,
  // nor a workspace change made elsewhere. Opening a project that lives in
  // another workspace (the palette and Search list every workspace) follows it
  // there instead of bouncing you Home. `seenProjectId` tells "you navigated to
  // a project" apart from "the workspace changed under an open project".
  const lastProject = useRef<{ id: string; name: string } | null>(null);
  const seenProjectId = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!guardRoute) return;
    const id = route.view === "project" ? route.projectId : undefined;
    const navigated = id !== seenProjectId.current;
    seenProjectId.current = id;
    if (!id) return;
    if (id.startsWith("tmp-")) return; // still being created — the id is about to change
    const p = projects.find((x) => x.id === id);
    if (p && !p.archivedAt) {
      lastProject.current = { id, name: p.name };
      if ((p.workspaceId ?? null) === workspace) return;
      if (navigated) { setWorkspace(p.workspaceId ?? null); return; }
    }
    const name = p?.name ?? (lastProject.current?.id === id ? lastProject.current.name : null);
    if (!p) {
      // only trust "it's gone" when the rest of this workspace's projects are
      // still here — a failed refetch returns an empty list, not a deletion
      const siblings = projects.some((x) => x.id !== "p-personal" && (x.workspaceId ?? null) === workspace);
      if (!siblings) return;
      setRoute({ view: "home" });
      toast.toast(name ? `“${name}” is no longer available — it may have been deleted.` : "That project is no longer available — it may have been deleted.");
      return;
    }
    setRoute({ view: "home" });
    if (p.archivedAt) toast.toast(canArchive(p) ? `“${p.name}” was archived. You can restore it from Archived in the sidebar.` : `“${p.name}” was archived.`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.view, route.projectId, projects, workspace, guardRoute]);

  // saved lists: hide at once, delete for real only when the Undo window closes
  const [hiddenSaved, setHiddenSaved] = useState<Set<string>>(() => new Set());
  const unhideSaved = (id: string) => setHiddenSaved((prev) => { if (!prev.has(id)) return prev; const n = new Set(prev); n.delete(id); return n; });
  const removeSaved = (s: SavedSearch, from: HTMLElement) => {
    if (!onDeleteSavedSearch) return;
    // keep keyboard focus in the list instead of dropping it to <body>
    const row = from.closest(".ksaved-row");
    const near = (row?.nextElementSibling ?? row?.previousElementSibling) as HTMLElement | null | undefined;
    const nextFocus = near?.matches("button") ? near : near?.querySelector<HTMLElement>("button");
    const hadFocus = document.activeElement === from;
    setHiddenSaved((prev) => new Set(prev).add(s.id));
    if (hadFocus) window.setTimeout(() => nextFocus?.focus(), 0);
    toast.action(`Removed “${s.name}”`, "Undo", () => unhideSaved(s.id), {
      onExpire: () => {
        let result: void | Promise<unknown>;
        try { result = onDeleteSavedSearch(s.id); } catch (e) { result = Promise.reject(e); }
        Promise.resolve(result)
          .then(() => unhideSaved(s.id))
          .catch(() => { unhideSaved(s.id); toast.error(`Couldn't remove “${s.name}”. Please try again.`); });
      },
    });
  };
  // count over the caller-provided global set (matches the global Search view);
  // fall back to the local (workspace-scoped) list only if not supplied.
  const smartRows = SMART_LISTS.map((s) => ({ ...s, count: smartCounts ? (smartCounts[s.id] ?? 0) : tasks.filter((t) => s.match(t, currentUserId)).length }));

  const navGroups: { label?: string; items: { id: Route["view"]; icon: IconName; label: string; badge?: number }[] }[] = [
    { items: [
      { id: "plan", icon: "calendarPlus", label: "Plan my day" },
      { id: "myweek", icon: "sun", label: "My week" },
      { id: "home", icon: "home", label: "Home" },
      { id: "inbox", icon: "inbox", label: "Inbox", badge: inboxCount },
      { id: "tasks", icon: "tasks", label: "My tasks", badge: myOpen },
      { id: "calendar", icon: "calendar", label: "Calendar" },
      { id: "search", icon: "search", label: "Search" },
      { id: "team", icon: "users", label: "Team" },
    ] },
    { label: "Reporting", items: [
      { id: "analytics", icon: "chart", label: "Analytics" },
      { id: "reports", icon: "trendingUp", label: "Reports" },
      { id: "workload", icon: "users", label: "Workload" },
      { id: "goals", icon: "target", label: "Goals" },
      { id: "portfolios", icon: "briefcase", label: "Portfolios" },
    ] },
    { label: "Intake & rules", items: [
      { id: "automations", icon: "zap", label: "Automations" },
      { id: "forms", icon: "inbox", label: "Forms" },
    ] },
  ];

  return (
    <aside aria-label="Sidebar" style={{
      width: 252, flexShrink: 0, height: "100%", display: "flex", flexDirection: "column",
      borderRight: "1px solid var(--hairline)", background: "color-mix(in oklch, var(--bg-deep) 70%, transparent)",
      backdropFilter: "blur(12px)", position: "relative", zIndex: 5,
    }}>
      <style>{SIDEBAR_CSS}</style>
      <a href="#main" className="kskip" onClick={(e) => { if (focusMain()) e.preventDefault(); }}>Skip to main content</a>
      {/* brand + workspace */}
      <div style={{ padding: "16px 16px 10px" }}>
        <button ref={wsBtnRef} onClick={() => setWsOpen((v) => !v)} aria-expanded={wsOpen} aria-controls={wsOpen ? "kws-menu" : undefined}
          aria-label={`Switch workspace, current: ${activeWs.name}`} style={{
          display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "7px 8px",
          borderRadius: 11, border: "1px solid var(--hairline)", background: "var(--surface)", cursor: "pointer",
        }}>
          {activeWs.logoUrl
            ? <img src={activeWs.logoUrl} alt="" style={{ width: 26, height: 26, borderRadius: 7, objectFit: "cover", flexShrink: 0 }} />
            : <KanboLogo size={26} />}
          <span style={{ flex: 1, textAlign: "left", minWidth: 0 }}>
            <span style={{ display: "block", fontFamily: "var(--font-head)", fontWeight: 600, fontSize: 14, letterSpacing: "0.15em", textTransform: "uppercase" }}>Kanbo</span>
            <span className="truncate" style={{ display: "block", fontSize: 11, color: "var(--ink-4)" }}>{activeWs.name}</span>
          </span>
          <Icon name="chevronDown" size={15} style={{ color: "var(--ink-4)", transform: wsOpen ? "rotate(180deg)" : "none", transition: "transform .2s" }} />
        </button>
        {wsOpen && (
          <div id="kws-menu" className="glass anim-scalein" style={{ padding: 6, marginTop: 6, borderRadius: 12 }}
            onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setWsOpen(false); wsBtnRef.current?.focus(); } }}>
            <div className="kicker" style={{ padding: "5px 8px 6px" }}>Workspaces</div>
            {workspaces.map((w) => (
              <button key={w.id ?? "personal"} onClick={() => switchWorkspace(w.id)} aria-current={w.id === workspace ? "true" : undefined} style={{
                display: "flex", alignItems: "center", gap: 9, width: "100%", padding: "7px 8px", borderRadius: 8,
                border: "none", cursor: "pointer", fontSize: 13.5, fontFamily: "var(--font-display)", textAlign: "left",
                color: w.id === workspace ? "var(--ink)" : "var(--ink-3)", background: w.id === workspace ? "var(--fill-2, color-mix(in oklch, var(--ink) 7%, transparent))" : "transparent",
              }}>
                {w.logoUrl
                  ? <img src={w.logoUrl} alt="" style={{ width: 18, height: 18, borderRadius: 5, objectFit: "cover", flexShrink: 0 }} />
                  : <Icon name={w.kind === "personal" ? "user" : "briefcase"} size={15} style={{ color: w.id === workspace ? "var(--accent)" : "currentColor" }} />}
                <span className="truncate" style={{ flex: 1, minWidth: 0 }}>{w.name}</span>
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

      {/* scrollable middle: nav + focus timer + projects all scroll together */}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
      {/* nav */}
      <nav aria-label="Main" style={{ padding: "4px 12px", display: "flex", flexDirection: "column", gap: 2 }}>
        {navGroups.map((g, gi) => (
          <div key={gi} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {g.label && <div className="kicker" style={{ padding: "10px 10px 4px" }}>{g.label}</div>}
            {g.items.map((n) => <NavItem key={n.id} icon={n.icon} label={n.label} badge={n.badge} active={route.view === n.id && (n.id !== "search" || !route.list)} onClick={() => setRoute({ view: n.id })} />)}
            {gi === 0 && (
              <>
                <div className="kicker" style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "10px 10px 4px" }}>
                  <span>Smart lists</span>
                  {/* these counts span every workspace (like Search); say so, so they
                      aren't mistaken for the workspace-scoped My tasks badge */}
                  {smartCounts && workspaces.length > 1 && <span title="Counts include tasks from every workspace" style={{ marginLeft: "auto", fontSize: 9.5, letterSpacing: "0.1em", fontWeight: 500, color: "var(--ink-4)" }}>All workspaces</span>}
                </div>
                {smartRows.map((s) => (
                  <NavItem key={s.id} icon={s.icon} label={s.label} badge={s.count} active={route.view === "search" && route.list === s.id} onClick={() => setRoute({ view: "search", list: s.id })} />
                ))}
                {savedSearches.filter((s) => !hiddenSaved.has(s.id)).map((s) => (
                  <div key={s.id} className="ksaved-row" style={{ position: "relative" }}>
                    <NavItem icon="filter" label={s.name} badge={savedSearchCounts?.[s.id]} active={route.view === "search" && route.list === s.id} onClick={() => setRoute({ view: "search", list: s.id })} />
                    {onDeleteSavedSearch && (
                      <button onClick={(e) => { e.stopPropagation(); removeSaved(s, e.currentTarget); }} aria-label={`Remove saved list ${s.name}`} title="Remove saved list"
                        className="ksaved-del" style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", border: "none", background: "var(--fill-2, var(--surface-2))", color: "var(--ink-3)", cursor: "pointer", width: 22, height: 22, borderRadius: 6, display: "grid", placeItems: "center", fontSize: 14, lineHeight: 1 }}>×</button>
                    )}
                  </div>
                ))}
              </>
            )}
          </div>
        ))}
      </nav>

      <DeepWorkMini focus={focus} onOpen={openFocus} />

      {/* projects */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px 18px 6px" }}>
        <span className="kicker" id="ksb-projects">Projects</span>
        {myRole !== "guest" && <button onClick={onNewProject} className="btn-icon" style={{ width: 24, height: 24, border: "none" }} title="New project" aria-label="New project"><Icon name="plus" size={15} /></button>}
      </div>
      {visibleProjects.length === 0 && <p style={{ margin: 0, fontSize: 12.5, color: "var(--ink-4)", padding: "6px 23px 12px" }}>No projects here yet.</p>}
      <div role="list" aria-labelledby="ksb-projects" style={{ padding: "0 12px 12px", display: "flex", flexDirection: "column", gap: 1 }}>
        {orderedProjects.map((p) => {
          const active = route.view === "project" && route.projectId === p.id;
          const count = projectOpen.get(p.id) ?? 0;
          const deletable = canDelete(p);
          const archivable = !!onArchiveProject && canArchive(p);
          const isPinned = pinned.has(p.id);
          // room the name leaves for the action group when it's revealed
          const reserve = (1 + (archivable ? 1 : 0) + (deletable ? 1 : 0)) * 25 + 10;
          return (
            <div key={p.id} role="listitem" className="kproj-item" style={{ "--kacts": `${reserve}px` } as CSSProperties}>
              <button onClick={() => setRoute({ view: "project", projectId: p.id })} className="kproj" data-active={active} aria-current={active ? "page" : undefined}>
                <span aria-hidden="true" style={{ width: 9, height: 9, borderRadius: 3, background: p.color, flexShrink: 0, boxShadow: `0 0 8px color-mix(in oklch, ${p.color} 60%, transparent)` }} />
                <span className="truncate" style={{ flex: 1, minWidth: 0 }}>{p.name}</span>
                {isPinned && <span className="kproj-pinmark" aria-hidden="true"><StarGlyph filled size={11} /></span>}
                {isPinned && <span className="sr-only">, pinned</span>}
                {count > 0 && <span className="mono tnum kproj-n" style={{ fontSize: 11, color: "var(--ink-4)" }}>{count}<span className="sr-only"> open {count === 1 ? "task" : "tasks"}</span></span>}
              </button>
              <div className="kproj-acts">
                <button type="button" className="kproj-act" data-on={isPinned} aria-pressed={isPinned}
                  aria-label={`Pin project ${p.name}`} title={isPinned ? "Unpin" : "Pin to top"}
                  onClick={(e) => { e.stopPropagation(); togglePin(p.id); }}>
                  <StarGlyph filled={isPinned} />
                </button>
                {archivable && (
                  <button type="button" className="kproj-act" aria-label={`Archive project ${p.name}`} title="Archive project"
                    onClick={(e) => { e.stopPropagation(); onArchiveProject!(p.id); }}>
                    <Icon name="archive" size={14} />
                  </button>
                )}
                {deletable && (
                  <button type="button" className="kproj-act" data-kind="delete" aria-label={`Delete project ${p.name}`} title="Delete project"
                    onClick={(e) => { e.stopPropagation(); onDeleteProject(p.id); }}>
                    <Icon name="trash" size={14} />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* archived projects */}
      {archivedProjects.length > 0 && (
        <div style={{ padding: "0 12px 12px" }}>
          <button onClick={() => setArchivedOpen((v) => !v)} aria-expanded={archivedOpen} style={{ display: "flex", alignItems: "center", gap: 7, width: "100%", padding: "6px 11px", border: "none", background: "transparent", cursor: "pointer", color: "var(--ink-4)" }}>
            <Icon name="chevronRight" size={13} style={{ transform: archivedOpen ? "rotate(90deg)" : "none", transition: "transform .18s" }} />
            <Icon name="archive" size={13} />
            <span className="kicker" style={{ flex: 1, textAlign: "left" }}>Archived</span>
            <span className="mono" style={{ fontSize: 11 }}>{archivedProjects.length}</span>
          </button>
          <Collapse open={archivedOpen}>{archivedProjects.map((p) => (
            <div key={p.id} className="kproj-row" style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 11px", opacity: 0.75 }}>
              <span style={{ width: 8, height: 8, borderRadius: 3, background: p.color, flexShrink: 0 }} />
              <span className="truncate" style={{ flex: 1, fontSize: 13, color: "var(--ink-3)" }}>{p.name}</span>
              {onRestoreProject && canArchive(p) && <button onClick={(e) => { e.stopPropagation(); onRestoreProject(p.id); }} title="Restore project" aria-label={`Restore project ${p.name}`} className="btn-icon" style={{ border: "none", background: "transparent", width: 26, height: 26, borderRadius: 7, color: "var(--ink-3)" }}><Icon name="refresh" size={13} /></button>}
            </div>
          ))}</Collapse>
        </div>
      )}
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
        {onOpenSettings && <button className="btn-icon" onClick={onOpenSettings} style={{ border: "none", width: 28, height: 28 }} title="Settings" aria-label="Settings"><Icon name="settings" size={16} /></button>}
        {onSignOut && <button className="btn-icon" onClick={() => { toast.flush(); onSignOut(); }} style={{ border: "none", width: 28, height: 28 }} title="Sign out" aria-label="Sign out"><Icon name="logout" size={16} /></button>}
      </div>
    </aside>
  );
}
