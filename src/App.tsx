/* ============================================================
   KANBO — App shell: auth gate, store-backed state, routing,
   timer, tasks page
   ============================================================ */
import { useState, useEffect, useCallback, useRef } from "react";
import { Icon, Segmented, GlobalTipStyles, type SegmentedOption } from "./components/primitives";
import { Sidebar } from "./components/Sidebar";
import { Topbar } from "./components/Topbar";
import { CommandPalette } from "./components/CommandPalette";
import { NewTaskModal } from "./components/NewTaskModal";
import { NewProjectModal } from "./components/NewProjectModal";
import { NewWorkspaceModal } from "./components/NewWorkspaceModal";
import { DeleteProjectModal, type DeleteMode } from "./components/DeleteProjectModal";
import { SettingsModal } from "./components/SettingsModal";
import { MobileNav } from "./components/MobileNav";
import { TrialBanner, UpgradeModal, Paywall, hasAccess, BILLING_ENABLED } from "./components/Billing";
import { ListView } from "./components/tasks/ListView";
import { BoardView, TimelineView, CalendarView } from "./components/tasks/OtherViews";
import { PlanView } from "./components/views/PlanView";
import { HomeView } from "./components/views/HomeView";
import { AnalyticsView } from "./components/views/AnalyticsView";
import { InboxView, TeamView } from "./components/views/InboxTeam";
import { FocusMode } from "./components/views/FocusMode";
import { TaskDetail } from "./components/TaskDetail";
import { LoginScreen, UpdatePasswordScreen } from "./auth/LoginScreen";
import { useAuth } from "./auth/AuthProvider";
import { useToast } from "./components/Toast";
import { reportError } from "./lib/monitoring";
import { useFocusTimer } from "./hooks/useFocusTimer";
import { useMediaQuery } from "./hooks/useMediaQuery";
import { store, type NewProject } from "./data/store";
import {
  STATUS_META, getProject, projectProgress, getMember, setReferenceData, toLocalISO, nextDueDate, MEMBERS,
} from "./data/data";
import type { ProfileDraft } from "./components/SettingsModal";
import type { Task, Project, Workspace, WorkspaceMember, TagDef, Comment, Activity, ActivityKind, Subscription, Plan, Status, Profile, CalProvider, CalendarConnection, ExternalEvent } from "./data/types";
import type { Route, TaskView, GroupBy } from "./app-types";

/* ---- tasks page with view switcher ---- */
const VIEW_OPTS: SegmentedOption<TaskView>[] = [
  { value: "list", label: "List", icon: "list" },
  { value: "board", label: "Board", icon: "board" },
  { value: "timeline", label: "Timeline", icon: "timeline" },
  { value: "calendar", label: "Calendar", icon: "calendar" },
];

const GROUP_OPTS: SegmentedOption<GroupBy>[] = [
  { value: "status", label: "Status" },
  { value: "priority", label: "Priority" },
  { value: "project", label: "Project" },
  { value: "none", label: "None" },
];

const PRIORITY_FILTERS: { value: string; label: string }[] = [
  { value: "all", label: "All priorities" },
  { value: "urgent", label: "Urgent" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];

function TasksPage({ tasks, allTasks, view, setView, groupBy, setGroupBy, smart, setSmart, onOpen, onToggle, onToggleSubtask, onAdd, onMove }: {
  tasks: Task[];
  allTasks: Task[];
  view: TaskView;
  setView: (v: TaskView) => void;
  groupBy: GroupBy;
  setGroupBy: (g: GroupBy) => void;
  smart: boolean;
  setSmart: React.Dispatch<React.SetStateAction<boolean>>;
  onOpen: (id: string) => void;
  onToggle: (id: string) => void;
  onToggleSubtask: (taskId: string, subId: string) => void;
  onAdd: (status: Status) => void;
  onMove: (taskId: string, status: Status) => void;
}) {
  const [filterOpen, setFilterOpen] = useState(false);
  const [priorityFilter, setPriorityFilter] = useState("all");
  const [hideDone, setHideDone] = useState(false);
  const isMobile = useMediaQuery("(max-width: 860px)");
  const filterActive = priorityFilter !== "all" || hideDone;
  const filtered = tasks.filter((t) =>
    (priorityFilter === "all" || t.priority === priorityFilter) && (!hideDone || t.status !== "done"));

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: isMobile ? 8 : 12, padding: isMobile ? "10px 14px" : "12px 24px", borderBottom: "1px solid var(--hairline)", flexShrink: 0, flexWrap: "wrap" }}>
        <Segmented options={VIEW_OPTS} value={view} onChange={setView} />
        {!isMobile && <div style={{ width: 1, height: 22, background: "var(--hairline)" }} />}
        {view === "list" && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {!isMobile && <span className="kicker">Group</span>}
            <Segmented options={GROUP_OPTS} value={groupBy} onChange={setGroupBy} />
          </div>
        )}
        <div style={{ flex: 1 }} />
        <div style={{ position: "relative" }}>
          <button onClick={() => setFilterOpen((v) => !v)} className="btn" style={{ padding: "8px 11px", border: filterActive ? "1px solid var(--accent)" : "1px solid var(--hairline)", background: filterActive ? "var(--accent-dim)" : "transparent", color: filterActive ? "var(--accent)" : "var(--ink-2)" }}>
            <Icon name="filter" size={15} /> Filter{filterActive ? " · on" : ""}
          </button>
          {filterOpen && (
            <>
              <div onClick={() => setFilterOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 30 }} />
              <div className="glass anim-scalein" style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 31, width: 200, padding: 8, borderRadius: 12, background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)" }}>
                <div className="kicker" style={{ padding: "5px 8px 6px" }}>Priority</div>
                {PRIORITY_FILTERS.map((p) => (
                  <button key={p.value} onClick={() => setPriorityFilter(p.value)} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "7px 8px", borderRadius: 8, border: "none", cursor: "pointer", textAlign: "left", fontSize: 13, fontFamily: "var(--font-display)", color: priorityFilter === p.value ? "var(--ink)" : "var(--ink-3)", background: priorityFilter === p.value ? "var(--surface-2)" : "transparent" }}>
                    {priorityFilter === p.value && <Icon name="check" size={13} style={{ color: "var(--accent)" }} />}
                    <span style={{ marginLeft: priorityFilter === p.value ? 0 : 21 }}>{p.label}</span>
                  </button>
                ))}
                <div className="divider" style={{ margin: "6px 4px" }} />
                <button onClick={() => setHideDone((v) => !v)} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "7px 8px", borderRadius: 8, border: "none", cursor: "pointer", textAlign: "left", fontSize: 13, fontFamily: "var(--font-display)", color: "var(--ink-2)", background: "transparent" }}>
                  <span style={{ width: 16, height: 16, borderRadius: 5, border: `1.5px solid ${hideDone ? "var(--accent)" : "var(--hairline-strong)"}`, background: hideDone ? "var(--accent)" : "transparent", display: "grid", placeItems: "center" }}>{hideDone && <Icon name="check" size={11} sw={3} style={{ color: "var(--on-accent)" }} />}</span>
                  Hide completed
                </button>
              </div>
            </>
          )}
        </div>
        <button onClick={() => setSmart((v) => !v)} className="btn" style={{
          padding: "8px 12px", border: smart ? "1px solid var(--accent)" : "1px solid var(--hairline)",
          background: smart ? "var(--accent-dim)" : "transparent", color: smart ? "var(--accent)" : "var(--ink-2)", fontWeight: 500,
        }}>
          <Icon name="sparkles" size={15} /> AI sort {smart ? "on" : "off"}
        </button>
      </div>
      {view === "list" && <ListView tasks={filtered} allTasks={allTasks} onOpen={onOpen} onToggle={onToggle} onToggleSubtask={onToggleSubtask} groupBy={groupBy} smart={smart} />}
      {view === "board" && <BoardView tasks={filtered} allTasks={allTasks} onOpen={onOpen} onAdd={onAdd} onMove={onMove} />}
      {view === "timeline" && <TimelineView tasks={filtered} allTasks={allTasks} onOpen={onOpen} />}
      {view === "calendar" && <CalendarView tasks={filtered} onOpen={onOpen} />}
    </>
  );
}

function FullLoader() {
  return (
    <div style={{ position: "relative", height: "100vh", display: "grid", placeItems: "center", overflow: "hidden" }}>
      <div className="app-bg" />
      <div className="glass anim-scalein" style={{ position: "relative", zIndex: 1, display: "flex", alignItems: "center", gap: 12, padding: "16px 22px", borderRadius: 16, background: "var(--surface-raised)" }}>
        <Icon name="sparkles" size={20} style={{ color: "var(--accent)" }} />
        <span className="ai-think" style={{ fontSize: 15, fontWeight: 600 }}>Loading your workspace…</span>
      </div>
    </div>
  );
}

export default function App() {
  const auth = useAuth();
  const { error: toastError, success: toastSuccess } = useToast();
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [tags, setTags] = useState<Record<string, TagDef>>({});
  const [activity, setActivity] = useState<Activity[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([{ id: null, name: "Personal", kind: "personal" }]);
  const [wsMembers, setWsMembers] = useState<WorkspaceMember[]>([]);
  const [newWorkspaceOpen, setNewWorkspaceOpen] = useState(false);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [checkoutBusy, setCheckoutBusy] = useState<Plan | null>(null);
  const [currentUserId, setCurrentUserId] = useState("m-self");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [calConnections, setCalConnections] = useState<CalendarConnection[]>([]);
  const [calEvents, setCalEvents] = useState<ExternalEvent[]>([]);
  const [calSyncing, setCalSyncing] = useState(false);
  const [route, setRouteRaw] = useState<Route>({ view: "plan" });
  const [workspace, setWorkspace] = useState<string | null>(store.configured ? null : "ws-foundrise");
  const [view, setView] = useState<TaskView>("list");
  const [groupBy, setGroupBy] = useState<GroupBy>("status");
  const [smart, setSmart] = useState(false);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [focusOpen, setFocusOpen] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [newTaskStatus, setNewTaskStatus] = useState<Status>("todo");
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [deleteProjectId, setDeleteProjectId] = useState<string | null>(null);
  const isMobile = useMediaQuery("(max-width: 860px)");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const focus = useFocusTimer();

  const tasksRef = useRef<Task[] | null>(null); tasksRef.current = tasks;
  const userIdRef = useRef(currentUserId); userIdRef.current = currentUserId;
  const projectsRef = useRef<Project[]>([]); projectsRef.current = projects;
  const tagsRef = useRef<Record<string, TagDef>>({}); tagsRef.current = tags;
  const workspacesRef = useRef<Workspace[]>([]); workspacesRef.current = workspaces;
  const workspaceRef = useRef<string | null>(null); workspaceRef.current = workspace;
  const [aiBusy, setAiBusy] = useState(false);

  // single source of truth for projects/tags: React state (drives re-renders) +
  // the module reference data (used by getProject()/<Tag> lookups deep in the tree).
  const applyProjects = useCallback((next: Project[]) => {
    setProjects(next);
    setReferenceData({ projects: next });
  }, []);
  const applyTags = useCallback((next: Record<string, TagDef>) => {
    setTags(next);
    setReferenceData({ tags: next });
  }, []);

  useEffect(() => { document.documentElement.setAttribute("data-theme", theme); }, [theme]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setCmdOpen((v) => !v); }
      if (e.key === "Escape") { setCmdOpen(false); setDetailId(null); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  // load data once the user is known (immediately in demo mode)
  const authUserId = auth.user?.id ?? null;
  useEffect(() => {
    if (auth.configured && !authUserId) { setTasks(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const b = await store.bootstrap(auth.user);
        if (!cancelled) { setTasks(b.tasks); applyProjects(b.projects); applyTags(b.tags); setWorkspaces(b.workspaces); setWsMembers(b.members); setCurrentUserId(b.currentUserId); setWorkspace(b.defaultWorkspace); setProfile(b.profile); }
        const feed = await store.listActivity();
        if (!cancelled) setActivity(feed);
        const subn = await store.getSubscription();
        if (!cancelled) setSubscription(subn);
      } catch (e) {
        reportError(e, { op: "bootstrap" });
        if (!cancelled) { setTasks([]); toastError("Couldn't load your workspace. Please refresh."); }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.configured, authUserId]);

  // real-time multi-tab/device sync: re-pull data (debounced) on remote changes
  useEffect(() => {
    if (!store.configured || !authUserId) return;
    let timer: ReturnType<typeof setTimeout>;
    const reload = async () => {
      try {
        const b = await store.bootstrap(auth.user);
        setTasks(b.tasks); applyProjects(b.projects); applyTags(b.tags); setWorkspaces(b.workspaces); setWsMembers(b.members); setProfile(b.profile);
        setActivity(await store.listActivity());
      } catch (e) { reportError(e, { op: "realtime-reload" }); }
    };
    const unsub = store.subscribeToChanges(() => { clearTimeout(timer); timer = setTimeout(reload, 500); });
    return () => { clearTimeout(timer); unsub(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUserId]);

  const setRoute = (r: Route) => {
    setRouteRaw(r);
    if (r.smart) setSmart(true);
    setDetailId(null);
    setSidebarOpen(false); // close the mobile drawer on navigation
  };

  /* append to the activity feed (Inbox) — fire-and-forget */
  const log = useCallback((kind: ActivityKind, task: { id: string | null; title: string }, detail: string) => {
    store.logActivity({ taskId: task.id, taskTitle: task.title, kind, detail }, userIdRef.current)
      .then((a) => setActivity((xs) => [a, ...xs]))
      .catch(reportError);
  }, []);

  /* ---- inbox archiving ---- */
  const archiveActivity = useCallback((id: string) => {
    setActivity((xs) => xs.filter((a) => a.id !== id)); // optimistic
    store.archiveActivity(id).catch((e) => { reportError(e); toastError("Couldn't archive that item."); });
  }, [toastError]);

  const clearInbox = useCallback(() => {
    setActivity((xs) => { if (!xs.length) return xs; return []; });
    store.clearInbox().then(() => toastSuccess("Inbox cleared")).catch((e) => { reportError(e); toastError("Couldn't clear the inbox."); });
  }, [toastSuccess, toastError]);

  /* ---- profile ---- */
  const uploadAvatar = useCallback((file: File) => store.uploadAvatar(userIdRef.current, file), []);

  const saveProfile = useCallback(async (draft: ProfileDraft) => {
    const email = auth.user?.email ?? getMember(userIdRef.current)?.email ?? "";
    const saved = await store.saveProfile(userIdRef.current, { ...draft, email });
    setProfile(saved);
    // reflect name/avatar/pronouns in reference data so every Avatar + assignee
    // label across the app updates immediately.
    const name = [saved.firstName, saved.lastName].filter(Boolean).join(" ").trim();
    setReferenceData({
      members: MEMBERS.map((m) => m.id === userIdRef.current
        ? { ...m, name: name || m.name, email: saved.email || m.email, pronouns: saved.pronouns || undefined, avatarUrl: saved.avatarUrl }
        : m),
    });
    toastSuccess("Profile saved");
  }, [auth.user?.email, toastSuccess]);

  /* ---- external calendars (Google / Microsoft) ---- */
  const refreshCalendar = useCallback(async () => {
    if (!store.configured) return;
    setCalSyncing(true);
    try {
      const conns = await store.listCalendarConnections();
      setCalConnections(conns);
      if (conns.length) {
        const start = new Date(); start.setDate(1); start.setHours(0, 0, 0, 0);
        const end = new Date(start); end.setMonth(end.getMonth() + 2);
        setCalEvents(await store.listExternalEvents(start.toISOString(), end.toISOString()));
      } else {
        setCalEvents([]);
      }
    } catch (e) { reportError(e); }
    finally { setCalSyncing(false); }
  }, []);

  const connectCalendar = useCallback(async (provider: CalProvider) => {
    try {
      const url = await store.getCalendarAuthUrl(provider);
      window.location.href = url; // full redirect to the provider's consent screen
    } catch (e) {
      reportError(e);
      toastError(e instanceof Error ? e.message : "Couldn't start the connection.");
    }
  }, [toastError]);

  const disconnectCalendar = useCallback(async (provider: CalProvider) => {
    try { await store.disconnectCalendar(provider); toastSuccess("Calendar disconnected"); refreshCalendar(); }
    catch (e) { reportError(e); toastError("Couldn't disconnect that calendar."); }
  }, [toastSuccess, toastError, refreshCalendar]);

  // load connected calendars on sign-in, and handle the OAuth round-trip return
  useEffect(() => {
    if (!store.configured || !authUserId) return;
    refreshCalendar();
    const params = new URLSearchParams(window.location.search);
    const cal = params.get("calendar");
    if (cal === "connected") { toastSuccess("Calendar connected"); setRouteRaw({ view: "calendar" }); }
    if (cal === "error") toastError("Couldn't connect that calendar. Please try again.");
    if (cal) {
      params.delete("calendar"); params.delete("fresh");
      const qs = params.toString();
      window.history.replaceState({}, "", window.location.pathname + (qs ? "?" + qs : ""));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUserId]);

  const persistTask = useCallback((raw: Task) => {
    // a task lives in its project's workspace
    const wsId = getProject(raw.projectId)?.workspaceId ?? null;
    const t: Task = { ...raw, workspaceId: wsId };
    setTasks((ts) => ts ? [t, ...ts] : [t]);
    store.createTask(t, userIdRef.current).then((saved) => {
      if (saved.id !== t.id) setTasks((ts) => ts && ts.map((x) => x.id === t.id ? saved : x));
      log("created", saved, "Task created");
    }).catch(reportError);
  }, [log]);

  // when a recurring task is completed, spawn its next occurrence
  const spawnRecurrence = useCallback((t: Task) => {
    if (!t.recurrence || t.recurrence === "none") return;
    const next: Task = {
      ...t,
      id: "t-rec-" + Date.now() + "-" + Math.round(Math.random() * 1e5),
      status: "todo",
      completedAt: undefined,
      dueDate: nextDueDate(t.dueDate, t.recurrence),
      scheduled: null,
      comments: 0,
      subtasks: t.subtasks.map((s) => ({ ...s, done: false })),
    };
    persistTask(next);
  }, [persistTask]);

  const toggleTask = useCallback((id: string) => {
    const cur = tasksRef.current; if (!cur) return;
    const t = cur.find((x) => x.id === id); if (!t) return;
    const becomingDone = t.status !== "done";
    const status: Status = becomingDone ? "done" : "todo";
    const completedAt = becomingDone ? toLocalISO(new Date()) : undefined;
    setTasks((ts) => ts && ts.map((x) => x.id === id ? { ...x, status, completedAt } : x));
    store.updateTask(id, { status, completedAt }).catch(reportError);
    log(becomingDone ? "completed" : "reopened", t, becomingDone ? "Marked complete" : "Reopened");
    if (becomingDone) spawnRecurrence(t);
  }, [log, spawnRecurrence]);

  const patchTask = useCallback((id: string, patch: Partial<Task>) => {
    const prev = tasksRef.current?.find((t) => t.id === id);
    setTasks((ts) => ts && ts.map((t) => t.id === id ? { ...t, ...patch } : t));
    store.updateTask(id, patch).catch(reportError);
    if (prev && patch.status && patch.status !== prev.status) {
      if (patch.status === "done") { log("completed", prev, "Marked complete"); spawnRecurrence(prev); }
      else log("status", prev, `Moved to ${STATUS_META[patch.status].label}`);
    }
  }, [log, spawnRecurrence]);

  const createTask = persistTask;

  const deleteTask = useCallback((id: string) => {
    const t = tasksRef.current?.find((x) => x.id === id);
    setTasks((ts) => ts && ts.filter((x) => x.id !== id));
    store.deleteTask(id).catch(reportError);
    if (t) log("deleted", { id: null, title: t.title }, "Task deleted");
  }, [log]);

  const addComment = useCallback(async (taskId: string, body: string): Promise<Comment | null> => {
    const t = tasksRef.current?.find((x) => x.id === taskId);
    const authorName = getMember(userIdRef.current)?.name || "You";
    try {
      const c = await store.addComment(taskId, body, userIdRef.current, authorName);
      if (t) {
        const count = t.comments + 1;
        setTasks((ts) => ts && ts.map((x) => x.id === taskId ? { ...x, comments: count } : x));
        store.updateTask(taskId, { comments: count }).catch(reportError);
        log("comment", t, body.length > 80 ? body.slice(0, 77) + "…" : body);
      }
      return c;
    } catch (e) {
      reportError(e, { op: "addComment" });
      toastError("Couldn't post the comment.");
      return null;
    }
  }, [log, toastError]);

  const toggleSubtask = useCallback((taskId: string, subId: string) => {
    const cur = tasksRef.current; if (!cur) return;
    const task = cur.find((t) => t.id === taskId);
    const sub = task?.subtasks.find((s) => s.id === subId); if (!sub) return;
    const done = !sub.done;
    setTasks((ts) => ts && ts.map((t) => t.id === taskId ? { ...t, subtasks: t.subtasks.map((s) => s.id === subId ? { ...s, done } : s) } : t));
    store.setSubtaskDone(subId, done).catch(reportError);
  }, []);

  const addSubtask = useCallback((taskId: string, title: string) => {
    const cur = tasksRef.current; const task = cur?.find((t) => t.id === taskId);
    const position = task?.subtasks.length ?? 0;
    store.addSubtask(taskId, title, position).then((sub) => {
      setTasks((ts) => ts && ts.map((t) => t.id === taskId ? { ...t, subtasks: [...t.subtasks, sub] } : t));
    }).catch(reportError);
  }, []);

  const createProject = useCallback((input: NewProject) => {
    // optimistic: show it immediately, reconcile/rollback with the server
    const tmpId = "tmp-proj-" + Date.now();
    const optimistic: Project = { id: tmpId, ...input };
    applyProjects([...projectsRef.current, optimistic]);
    store.createProject(input, userIdRef.current)
      .then((p) => applyProjects(projectsRef.current.map((x) => x.id === tmpId ? p : x)))
      .catch((e) => {
        reportError(e, { op: "createProject" });
        applyProjects(projectsRef.current.filter((x) => x.id !== tmpId));
        toastError("Couldn't save the project: " + (e?.message || e));
      });
  }, [applyProjects, toastError]);

  const confirmDeleteProject = useCallback((id: string, mode: DeleteMode, targetId?: string) => {
    if (id === "p-personal") { setDeleteProjectId(null); return; } // built-in default can't be deleted
    const affected = (tasksRef.current || []).filter((t) => t.projectId === id);
    if (mode === "reassign") {
      const target = targetId || "p-personal";
      setTasks((ts) => ts && ts.map((t) => t.projectId === id ? { ...t, projectId: target } : t));
      affected.forEach((t) => store.updateTask(t.id, { projectId: target }).catch(reportError));
    } else {
      setTasks((ts) => ts && ts.filter((t) => t.projectId !== id));
      affected.forEach((t) => store.deleteTask(t.id).catch(reportError));
    }
    applyProjects(projectsRef.current.filter((p) => p.id !== id));
    store.deleteProject(id).catch(reportError);
    setRouteRaw((r) => r.view === "project" && r.projectId === id ? { view: "tasks" } : r);
    setDeleteProjectId(null);
  }, [applyProjects]);

  const createTag = useCallback((label: string, color: string) => {
    const tmpId = "tmp-tag-" + Date.now();
    applyTags({ ...tagsRef.current, [tmpId]: { label, color } });
    store.createTag(label, color, userIdRef.current)
      .then((tag) => {
        const next = { ...tagsRef.current };
        delete next[tmpId];
        next[tag.id] = { label: tag.label, color: tag.color };
        applyTags(next);
      })
      .catch((e) => {
        reportError(e, { op: "createTag" });
        const next = { ...tagsRef.current }; delete next[tmpId]; applyTags(next);
        toastError("Couldn't save the tag: " + (e?.message || e));
      });
  }, [applyTags, toastError]);

  const deleteTag = useCallback((id: string) => {
    // drop it from any tasks that use it, then remove the tag
    const cur = tasksRef.current || [];
    const affected = cur.filter((t) => t.tags.includes(id));
    if (affected.length) {
      setTasks((ts) => ts && ts.map((t) => t.tags.includes(id) ? { ...t, tags: t.tags.filter((x) => x !== id) } : t));
      affected.forEach((t) => store.updateTask(t.id, { tags: t.tags.filter((x) => x !== id) }).catch(reportError));
    }
    const next = { ...tagsRef.current }; delete next[id]; applyTags(next);
    store.deleteTag(id).catch(reportError);
  }, [applyTags]);

  const createWorkspace = useCallback((name: string) => {
    const me = getMember(userIdRef.current);
    store.createWorkspace(name, { id: userIdRef.current, email: me?.email || "", name: me?.name || "You" })
      .then((w) => {
        setWorkspaces((ws) => [...ws, w]);
        setWsMembers((m) => [...m, { id: "owner-" + w.id, workspaceId: w.id!, userId: userIdRef.current, email: me?.email || "", name: me?.name || "You", role: "owner", status: "active" }]);
        setReferenceData({ workspaces: [...workspacesRef.current, w] });
        setWorkspace(w.id);
        setRoute({ view: "team" });
      })
      .catch((e) => { reportError(e, { op: "createWorkspace" }); toastError("Couldn't create the workspace: " + (e?.message || e)); });
  }, [toastError]);

  const inviteMember = useCallback((workspaceId: string, email: string) => {
    store.inviteMember(workspaceId, email)
      .then((m) => setWsMembers((xs) => [...xs, m]))
      .catch((e) => { reportError(e, { op: "inviteMember" }); toastError("Couldn't send the invite: " + (e?.message || e)); });
  }, [toastError]);

  const removeMember = useCallback((memberId: string) => {
    setWsMembers((xs) => xs.filter((m) => m.id !== memberId));
    store.removeMember(memberId).catch(reportError);
  }, []);

  // returning from Stripe checkout → refresh subscription + toast, clean the URL
  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get("billing");
    if (!p) return;
    if (p === "success") {
      store.getSubscription().then(setSubscription).catch(reportError);
      toastSuccess("You're all set — welcome to Kanbo.");
    }
    window.history.replaceState({}, "", window.location.pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startCheckout = useCallback(async (plan: Plan) => {
    setCheckoutBusy(plan);
    try {
      const seats = Math.max(1, wsMembers.filter((m) => m.status === "active").length || 1);
      const url = await store.startCheckout(plan, seats);
      if (url) window.location.href = url;
      else { toastError("Checkout isn't connected yet — deploy the Stripe functions to enable it."); setCheckoutBusy(null); }
    } catch (e) { reportError(e, { op: "startCheckout" }); toastError("Couldn't start checkout: " + ((e as Error)?.message || e)); setCheckoutBusy(null); }
  }, [wsMembers, toastError]);

  const manageBilling = useCallback(async () => {
    try {
      const url = await store.openBillingPortal();
      if (url) window.location.href = url;
      else toastError("Billing portal isn't connected yet.");
    } catch (e) { reportError(e, { op: "manageBilling" }); toastError("Couldn't open billing."); }
  }, [toastError]);

  // AI auto-prioritize: real LLM (Edge Function) with heuristic fallback
  const autoPrioritize = useCallback(async () => {
    const cur = tasksRef.current; if (!cur) return;
    setRouteRaw({ view: "tasks" }); setSmart(true); setSidebarOpen(false); setDetailId(null);
    setAiBusy(true);
    try {
      const scope = cur.filter((t) => (t.workspaceId ?? null) === workspaceRef.current);
      const res = await store.aiPrioritize(scope, toLocalISO(new Date()));
      const byId = new Map(res.items.map((i) => [i.id, i]));
      setTasks((ts) => ts && ts.map((t) => byId.has(t.id) ? { ...t, aiScore: byId.get(t.id)!.score, aiReason: byId.get(t.id)!.reason } : t));
      res.items.forEach((i) => store.updateTask(i.id, { aiScore: i.score, aiReason: i.reason }).catch(() => {}));
      toastSuccess((res.source === "ai" ? "✨ " : "") + res.summary);
    } catch (e) {
      reportError(e, { op: "autoPrioritize" });
      toastError("Couldn't prioritize right now.");
    } finally { setAiBusy(false); }
  }, [toastSuccess, toastError]);

  const openNewTask = useCallback((status: Status = "todo") => { setNewTaskStatus(status); setNewTaskOpen(true); }, []);

  const openFocus = () => { focus.setRunning(true); setFocusOpen(true); };
  const focusTask = (id: string) => { focus.setTaskId(id); setDetailId(null); setFocusOpen(true); focus.setRunning(true); };

  // ---- auth / loading gates ----
  if (auth.recovery) return <UpdatePasswordScreen />;
  if (auth.configured && !auth.user) return <LoginScreen />;
  if (auth.loading || tasks === null) return <FullLoader />;
  if (subscription && !hasAccess(subscription)) {
    const seats = Math.max(1, wsMembers.filter((m) => m.status === "active").length || 1);
    return <Paywall sub={subscription} seats={seats} busyPlan={checkoutBusy} onChoose={startCheckout} onSignOut={auth.configured ? auth.signOut : undefined} />;
  }

  // scope everything to the active workspace
  const allTasks = tasks.filter((t) => (t.workspaceId ?? null) === workspace);

  const activeWsName = workspaces.find((w) => w.id === workspace)?.name || "Personal";

  // scope tasks by route
  let scoped = allTasks, title = "My tasks", subtitle = "Everything assigned to you", breadcrumb = activeWsName;
  let newProj = getProject("");
  if (route.view === "tasks") { scoped = allTasks.filter((t) => t.assigneeId === currentUserId); }
  else if (route.view === "project" && route.projectId) {
    const p = getProject(route.projectId); newProj = p;
    scoped = allTasks.filter((t) => t.projectId === route.projectId);
    title = p?.name || "Project"; subtitle = scoped.length + " tasks · " + projectProgress(allTasks, route.projectId) + "% complete";
    breadcrumb = workspaces.find((w) => w.id === (p?.workspaceId ?? null))?.name || "Personal";
  }
  const wsProjects = projects.filter((p) => (p.workspaceId ?? null) === workspace);

  const inboxCount = activity.filter((a) => Date.now() - new Date(a.createdAt).getTime() < 86400000).length;
  const currentUser = getMember(currentUserId);
  const firstName = currentUser?.name?.trim().split(/\s+/)[0] || "there";
  const hour = new Date().getHours();
  const greet = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const monthLabel = new Date().toLocaleDateString(undefined, { month: "long", year: "numeric" });

  const renderMain = () => {
    switch (route.view) {
      case "plan": return <PlanView tasks={allTasks} onUpdate={patchTask} onCreate={createTask} onOpen={setDetailId} />;
      case "home": return <HomeView tasks={allTasks} projects={wsProjects} userName={currentUser?.name} onOpen={setDetailId} setRoute={setRoute} openFocus={openFocus} onNewProject={() => setNewProjectOpen(true)} onAutoPrioritize={autoPrioritize} aiBusy={aiBusy} />;
      case "analytics": return <AnalyticsView tasks={allTasks} />;
      case "inbox": return <InboxView activity={activity} tasks={allTasks} onOpen={setDetailId} onArchive={archiveActivity} onClearAll={clearInbox} />;
      case "calendar": return <CalendarView tasks={allTasks} onOpen={setDetailId} connections={calConnections} externalEvents={calEvents} onConnect={connectCalendar} onDisconnect={disconnectCalendar} syncing={calSyncing} />;
      case "team": return <TeamView tasks={allTasks} workspace={workspace} workspaces={workspaces} members={wsMembers} currentUserId={currentUserId} onInvite={inviteMember} onRemoveMember={removeMember} onNewWorkspace={() => setNewWorkspaceOpen(true)} />;
      case "tasks":
      case "project":
        return <TasksPage tasks={scoped} allTasks={allTasks} view={view} setView={setView} groupBy={groupBy} setGroupBy={setGroupBy} smart={smart} setSmart={setSmart} onOpen={setDetailId} onToggle={toggleTask} onToggleSubtask={toggleSubtask} onAdd={openNewTask} onMove={(id, status) => patchTask(id, { status, completedAt: status === "done" ? toLocalISO(new Date()) : undefined })} />;
      default: return null;
    }
  };

  const headerMap: Record<Route["view"], { title: string; subtitle: string; breadcrumb: string }> = {
    plan: { title: `${greet}, ${firstName}`, subtitle: "Here's your day.", breadcrumb: "Plan" },
    home: { title: "Home", subtitle: "A focused look at what's moving today.", breadcrumb: "Today" },
    analytics: { title: "Analytics", subtitle: "Your throughput, measured.", breadcrumb: "Insights" },
    inbox: { title: "Inbox", subtitle: "Mentions, assignments, and updates.", breadcrumb: "Notifications" },
    calendar: { title: "Calendar", subtitle: monthLabel, breadcrumb: "Schedule" },
    team: { title: "Team", subtitle: "Who's working on what.", breadcrumb: "People" },
    tasks: { title, subtitle, breadcrumb },
    project: { title, subtitle, breadcrumb },
  };
  const headerProps = headerMap[route.view];

  const sidebar = (
    <Sidebar route={route} setRoute={setRoute} workspace={workspace} setWorkspace={setWorkspace} workspaces={workspaces} onNewWorkspace={() => setNewWorkspaceOpen(true)} focus={focus} openFocus={openFocus} tasks={allTasks} projects={projects} inboxCount={inboxCount}
      currentUserId={currentUserId} currentUser={currentUser} onSignOut={auth.configured ? auth.signOut : undefined} onOpenSettings={() => setSettingsOpen(true)} onNewProject={() => setNewProjectOpen(true)} onDeleteProject={(id) => setDeleteProjectId(id)}
      subscription={subscription} onUpgrade={() => setUpgradeOpen(true)} onManageBilling={manageBilling} />
  );

  return (
    <div style={{ position: "relative", height: "100vh", display: "flex", overflow: "hidden" }}>
      <div className="app-bg" /><div className="app-grid" />
      <GlobalTipStyles />
      {isMobile ? (
        <>
          {sidebarOpen && <div onClick={() => setSidebarOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 49, background: "color-mix(in oklch, var(--bg-deep) 50%, transparent)", backdropFilter: "blur(2px)" }} />}
          <div style={{ position: "fixed", top: 0, left: 0, bottom: 0, zIndex: 50, transform: sidebarOpen ? "none" : "translateX(-100%)", transition: "transform .25s var(--ease)", boxShadow: sidebarOpen ? "var(--shadow-lg)" : "none" }}>
            {sidebar}
          </div>
        </>
      ) : sidebar}
      <main style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", position: "relative", zIndex: 1 }}>
        {BILLING_ENABLED && subscription?.status === "trialing" && <TrialBanner sub={subscription} onUpgrade={() => setUpgradeOpen(true)} />}
        <Topbar {...headerProps} theme={theme} toggleTheme={() => setTheme((t) => t === "dark" ? "light" : "dark")}
          hasUnread={inboxCount > 0} onMenu={isMobile ? () => setSidebarOpen(true) : undefined}
          onNewTask={() => openNewTask()} onNewProject={() => setNewProjectOpen(true)} onCommand={() => setCmdOpen(true)} onBell={() => setRoute({ view: "inbox" })}>
          {(route.view === "project") && newProj && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "0 4px" }}>
              <span style={{ fontSize: 22 }}>{newProj.emoji}</span>
            </span>
          )}
        </Topbar>
        {renderMain()}
        {isMobile && <MobileNav route={route} setRoute={setRoute} inboxCount={inboxCount} />}
      </main>

      <CommandPalette open={cmdOpen} onClose={() => setCmdOpen(false)} tasks={allTasks} onOpenTask={setDetailId} onAction={(s) => {
        if (s.label.includes("New task")) openNewTask();
        else if (s.label.includes("prioritize") || s.label.includes("focus on next")) autoPrioritize();
        else if (s.label.includes("focus")) openFocus();
        else if (s.label.includes("board")) { setRoute({ view: "tasks" }); setView("board"); }
        else if (s.label.includes("analytics")) setRoute({ view: "analytics" });
      }} />
      {detailId && <TaskDetail taskId={detailId} tasks={allTasks} tags={tags} activity={activity} members={wsMembers} currentUserId={currentUserId} onClose={() => setDetailId(null)} onToggle={toggleTask} onPatch={patchTask} onDelete={deleteTask} onToggleSubtask={toggleSubtask} onAddSubtask={addSubtask} onCreateTag={createTag} onDeleteTag={deleteTag} onAddComment={addComment} onFocus={focusTask} />}
      {focusOpen && <FocusMode focus={focus} tasks={allTasks} onClose={() => setFocusOpen(false)} onOpenTask={(id) => { setFocusOpen(false); setDetailId(id); }} />}
      <NewTaskModal open={newTaskOpen} onClose={() => setNewTaskOpen(false)} onCreate={createTask} onCreateTag={createTag} onDeleteTag={deleteTag} projects={wsProjects} allTags={tags} members={wsMembers} currentUserId={currentUserId} defaultStatus={newTaskStatus} />
      <NewProjectModal open={newProjectOpen} onClose={() => setNewProjectOpen(false)} onCreate={createProject} workspaceId={workspace} />
      <NewWorkspaceModal open={newWorkspaceOpen} onClose={() => setNewWorkspaceOpen(false)} onCreate={createWorkspace} />
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)}
        initial={{ firstName: profile?.firstName ?? "", lastName: profile?.lastName ?? "", pronouns: profile?.pronouns ?? "", avatarUrl: profile?.avatarUrl ?? null }}
        email={auth.user?.email ?? currentUser?.email ?? ""} color={currentUser?.color ?? "oklch(0.585 0.196 264)"}
        onUpload={uploadAvatar} onSave={saveProfile} />
      <UpgradeModal open={upgradeOpen} onClose={() => setUpgradeOpen(false)} seats={Math.max(1, wsMembers.filter((m) => m.status === "active").length || 1)} busyPlan={checkoutBusy} onChoose={startCheckout} />
      {deleteProjectId && (() => {
        const proj = getProject(deleteProjectId);
        if (!proj) return null;
        return <DeleteProjectModal project={proj} taskCount={allTasks.filter((t) => t.projectId === deleteProjectId).length} projects={projects}
          onConfirm={(mode, target) => confirmDeleteProject(deleteProjectId, mode, target)} onClose={() => setDeleteProjectId(null)} />;
      })()}
    </div>
  );
}
