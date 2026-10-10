/* ============================================================
   KANBO — App shell: auth gate, store-backed state, routing
   (real addresses, Back/Forward), the page header, and the wiring
   between every view and the store.
   ============================================================ */
import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo, lazy, Suspense } from "react";
import { Icon, GlobalTipStyles, AppBg, Button, IconButton, type TabItem } from "./components/primitives";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { FullLoader } from "./components/FullLoader";
import { PlaceSkeleton, PanelSkeleton, skeletonFor } from "./components/PlaceSkeleton";
import { Sidebar } from "./components/Sidebar";
import { PageHeader, type PageHeaderProps } from "./components/Topbar";
import type { DeleteMode } from "./components/DeleteProjectModal";
import type { ThemeChoice, SettingsSection, ProfileDraft } from "./components/SettingsModal";
import { MobileNav } from "./components/MobileNav";
import { hasAccess, BILLING_ENABLED } from "./lib/billing";
import type { ImportRow } from "./components/ImportTasksModal";
import { TAG_COLORS, resolveTagId } from "./lib/tags";
import { TodayView } from "./components/views/TodayView";
import type { FormValues } from "./components/views/RulesForms";
import { WhatMoved, markWhatMovedSeen } from "./components/WhatMoved";
import { PublicSite, UpdatePasswordScreen, PendingApproval } from "./entryChunks";
// Every place but Today, and everything opened on top of a page, is its own
// chunk: fetched on first use (behind a skeleton), on hover/focus of a link to
// it, or while the browser is idle (lazyViews.ts)
import {
  MyWeekView, CalendarView, HomeView, InboxView, TasksPage, ProjectTitleAddon, ProjectActions, ProjectPanels, ProjectNotice,
  SearchView, ProjectsView, GoalsView, PortfoliosView, AutomationsView, FormsView, RecycleBin, TeamPulse, TeamView,
  WorkspaceSettingsPanel, WorkloadView, AnalyticsView, ReportsView, DocsTab,
  TaskDetail, CommandPalette, SettingsModal, NewTaskModal, NewProjectModal, NewWorkspaceModal, DeleteProjectModal,
  ImportTasksModal, OnboardingModal, WelcomeModal, QuickCapture, ExtractTasksSheet, ShutdownSheet, WeeklyReview,
  FocusMode, PlannerHost, TrialBanner, UpgradeModal, Paywall, likelyNext, everyScreen, prefetchRoute,
  TourHost, SetupChecklist, HelpMenu, QuickAddSheet, prefetchQuickAdd, TemplateLibrary, SaveAsTemplate, TodayStreak, TodayWins,
} from "./lazyViews";
import { canPrefetchAhead, prefetchWhenIdle, whenIdle } from "./lib/lazyLoad";
import { useAuth } from "./auth/AuthProvider";
import { useToast } from "./components/Toast";
import { reportError } from "./lib/monitoring";
import { useFocusTimer } from "./hooks/useFocusTimer";
import { useMediaQuery } from "./hooks/useMediaQuery";
import { store, keepOnScreen, getStrippedColumns, stampCreator, type NewProject, type AppBanner, type Bootstrap, type RealtimeChange } from "./data/store";
import { offlineQueue, type DeadLetter } from "./lib/offlineQueue";
import { DAY_CHANGE_EVENT, subscribeMinute } from "./lib/liveClock";
import { canArchiveProject } from "./lib/permissions";
import { routeOf, pathOf, placeOf, tabsFor, titleOf, G_KEYS, type NavCtx, type PlaceTab } from "./lib/nav";
import { splitPersonal, withOverlay, writePlanOverlay, writeSectionOverlay, writeScoreOverlay, prunePlanOverlay, type PersonalKey } from "./lib/planOverlay";
import { undoLast } from "./lib/undoStack";
import { computeRisks, readCapacities } from "./lib/radar";
import { shutdownDone } from "./lib/rituals";
import { momentumCounts } from "./lib/brief";
import type { AskAction, AskContext } from "./lib/askTypes";
import { isPushOnHere, listenForPushMessages } from "./lib/push";
import { installState, isStandalone, promptInstall, takeNewTaskShortcut } from "./lib/install";
// 0048 (the UX wave): drag to plan, the guided first run, shared views, drops on projects and people, quick add
import { DragLayer } from "./lib/dnd";
import { todayListPatches } from "./components/dnd/todayNav";
import { prefetchPlanMenus } from "./components/dnd/lazy";
import {
  useOnboardingState, useTourWanted, tourRoleOf, shouldAutoStartTour, setupSignals, useShowSetupChecklist, demoOnboardingState,
  createTourSample, removeTourSample, checklistProgress, dismissSetupChecklist, startTour, type TourSampleDeps,
} from "./lib/onboarding";
import { useSavedViews, viewCounts, getSavedView, viewRoute, canShareViews } from "./lib/views";
import { viewPageStart } from "./lib/savedViews/pageQuery";
import { moveTasksToProject, reassignTasks, type MoveDeps } from "./lib/dropActions";
import { recentProjectIds } from "./components/phone/quickAdd";
import type { AppliedTemplatePlan } from "./lib/templatePlan";
import type { BoardSettingsChange } from "./components/tasks/otherViewsLogic";
import { ApprovalSummariesProvider } from "./components/approvals/ApprovalSummaries";
import { approvalFailure, approvalsInWorkspace, listApprovalSummaries, listMyApprovals, subscribeApprovals, waitingOnApproval } from "./lib/approvals";
import type { BinUndoResult } from "./lib/trash";
import { docMentionInWorkspace, docMentionRoute } from "./lib/docMentions";
import type { DocMakeTask } from "./components/docs/DocEditor";
import type { HistoryLogProps } from "./components/bin/HistoryLog";
import type { InsightsNavProps } from "./components/views/InsightsSummary";
import { loadAppearance, saveAppearance, type Appearance } from "./lib/appearance";
import { SMART_LISTS, smartListQuery } from "./lib/smartLists";
import {
  STATUS_META, getProject, getMember, setReferenceData, toLocalISO, todayISO, MEMBERS, KANBO_TODAY, energyOf, SELF_COLOR,
} from "./data/data";
import type { Task, Subtask, Project, Workspace, WorkspaceMember, Role, TagDef, Comment, Activity, ActivityKind, Subscription, Plan, Status, Profile, CalProvider, CalendarConnection, CalendarWarning, ExternalEvent, Section, CustomFieldDef, SavedSearch, Goal, Portfolio, StatusUpdate, StatusKind, AutomationRule, AutomationAction, FormDef, FormFieldKey, IconName, WorkspaceTemplate, Member, ApprovalSummary, MyApprovals, AppliedProjectPlan, NotifyPrefs,
  BoardSettings, LibraryTemplate, MomentumPrefs, OnboardingState, SetupItemId } from "./data/types";
import type { Route, TaskView, GroupBy, ProjectTab } from "./app-types";
import {
  newTaskId, isTaskId, descendantsOf, parentsFirst, runLimited, createLimiter, swapTmp, keepTmp, statusTransition, buildRecurrence,
  unseenCreates, reloadProjects, reloadWorkspaces,
  cloneTaskTree, pickFields, topLevelProgress, pickStartWorkspace, lastWorkspaceKey, type Limiter,
} from "./lib/taskOps";

// Settings › Workspace › History loads with that section: a chunk that can't be
// fetched shows nothing there (the rest of Settings carries on)
const HistoryLog = lazy<React.ComponentType<HistoryLogProps>>(() => import("./components/bin/HistoryLog").then((m) => ({ default: m.HistoryLog }), () => ({ default: () => null })));

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** Undo from the recycle bin (lib/trash, fetched the first time it's needed). Never rejects:
 *  if that code can't be fetched, nothing came back (the bin still has it all). */
const restoreDeletedItems = (ids: string[]): Promise<BinUndoResult> => import("./lib/trash").then((m) => m.restoreDeletedItems(ids), (e: unknown) => {
  reportError(e, { op: "chunk-load" });
  return { status: "failed", restored: [], failed: [], missing: [], notes: [], results: [] };
});
const GUEST_MSG = "Guests can view and comment — ask a workspace admin for member access";
// activity the signed-in user wrote about their own actions — history, not notifications
const SELF_KINDS = new Set<ActivityKind>(["created", "status", "completed", "reopened", "deleted"]);

/** A locally-created task the server hasn't confirmed yet. `until` is null while
 *  the insert is in flight (or failed); once saved it lingers for 30s so a reload
 *  that raced the insert can't make it blink out. */
type PendingCreate = { id: string; task: Task; until: number | null };
type CreateOpts = { log?: boolean; notify?: boolean; slot?: Limiter };
type CommitOpts = { notify?: boolean; op?: string; onFailed?: (ids: string[]) => void; retry?: () => void; failMessage?: (failed: number) => string };
/** Side effects of status changes, held until the save settles: activity rows are
 *  only logged for saves that stuck, and a failed completion takes back the
 *  recurrence it spawned (a failed reopen puts back the one it removed). */
type StatusFx = { logs: Map<string, () => void>; completing: Set<string>; unspawned: Map<string, Task> };
const newStatusFx = (): StatusFx => ({ logs: new Map(), completing: new Set(), unspawned: new Map() });
const UNDO_MS = 10000;
/** Inbox items taken off screen by one archive, and that archive's save. */
type ArchivePart = { items: Activity[]; archived: Promise<void> };

/** Lets an error boundary catch errors thrown while building a view's props, too. */
function RenderView({ render }: { render: () => React.ReactNode }) { return <>{render()}</>; }

const TASK_VIEWS: readonly TaskView[] = ["list", "board", "timeline", "calendar", "files", "matrix"];
/** (0048: Search saves views now — its old saved-search props get these) */
const NO_SAVED_SEARCHES: SavedSearch[] = [];
const noop = () => {};
const isTaskView = (v: string | undefined): v is TaskView => !!v && (TASK_VIEWS as readonly string[]).includes(v);
const GROUP_BYS: readonly GroupBy[] = ["status", "section", "due", "priority", "project", "none"];
const isGroupBy = (v: unknown): v is GroupBy => typeof v === "string" && (GROUP_BYS as readonly string[]).includes(v);
/** A project's own view and grouping, remembered per project (and apart from My tasks'). */
type ProjectPrefs = { view: TaskView; groupBy: GroupBy };
const projectPrefsKey = (id: string) => `kanbo-pview-${id}`;
function readProjectPrefs(id: string): ProjectPrefs {
  try {
    const c = JSON.parse(localStorage.getItem(projectPrefsKey(id)) || "{}") as { view?: string; groupBy?: unknown };
    return { view: isTaskView(c.view) ? c.view : "list", groupBy: isGroupBy(c.groupBy) ? c.groupBy : "status" };
  } catch { return { view: "list", groupBy: "status" }; }
}
type DueFocus = "today" | "overdue" | "week";
const isDueFocus = (v: string | undefined): v is DueFocus => v === "today" || v === "overdue" || v === "week";

/** Where the address bar should point: the route's canonical path and query,
 *  the open task (?task=), the text handed to Search (?q=), and every other
 *  parameter in `keep` (a billing or calendar return is cleared by its own effect). */
function addressFor(route: Route, opts: { task?: string | null; q?: string | null }, keep = ""): string {
  const [path, own = ""] = pathOf(route).split("?");
  const params = new URLSearchParams(own);
  // (the route's own parameters — ?due=, a saved view's ?view= — come from the route, never from the old address)
  new URLSearchParams(keep).forEach((v, k) => { if (k !== "due" && k !== "view" && k !== "task" && k !== "q") params.append(k, v); });
  if (opts.q && route.view === "search" && !route.list) params.set("q", opts.q);
  if (opts.task) params.set("task", opts.task);
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}
const sameRoute = (a: Route, b: Route) => a.view === b.view && (a.projectId ?? "") === (b.projectId ?? "") && (a.list ?? "") === (b.list ?? "") && (a.tab ?? "") === (b.tab ?? "");
/** Where a route really goes for this person in this workspace: Personal has no
 *  Pulse (its /team is Insights), and guests have no Rules, the workspace's or a
 *  project's. Everything else goes where it says. */
function normaliseRoute(r: Route, ctx: { personal: boolean; guest: boolean }): Route {
  if (ctx.personal && r.view === "pulse") return { view: "analytics" };
  if (ctx.guest && r.view === "automations") return { view: "projects" };
  // a project's address always names its tab: a bare /p/:id opens the view the project
  // was last shown in (List the first time), so Back and a reload come back to it
  if (r.view === "project" && r.projectId && (!r.tab || (ctx.guest && r.tab === "rules"))) {
    return { view: "project", projectId: r.projectId, tab: readProjectPrefs(r.projectId).view };
  }
  return r;
}
/** One page: a place, or one project in it (its tabs are the same page). */
const pageOf = (r: Route) => `${placeOf(r)}:${r.view === "project" ? r.projectId ?? "" : ""}`;
/** Whose plan a task carries once a change lands: a change that hands the task to
 *  someone (you included) decides, otherwise its assignee. */
const ownerAfter = (t: Task, patch: Partial<Task>) => ("assigneeId" in patch ? patch.assigneeId : t.assigneeId);
/** The row's plan (its slot, "on today", My-tasks section) is its assignee's, so a change
 *  of assignee that doesn't set them itself clears them: a task you hand on never lands in
 *  your slot on their day, and one you take never brings their plan with it. These are
 *  the fields to clear alongside `patch` (Kanbo's score stays: a ranking hint, not a plan). */
const releasedPlan = (t: Task, patch: Partial<Task>): Partial<Task> => {
  if (!("assigneeId" in patch) || (patch.assigneeId ?? null) === (t.assigneeId ?? null)) return {};
  const out: Partial<Task> = {};
  if (!("planToday" in patch) && t.planToday) out.planToday = false;
  if (!("scheduled" in patch) && t.scheduled != null) out.scheduled = null;
  if (!("mySectionId" in patch) && t.mySectionId) out.mySectionId = undefined;
  return out;
};
/** What a guarded change replaced: the row's own fields, and your plan on someone else's task. */
type GuardedUndo = { id: string; row: Partial<Task>; plan: Partial<Pick<Task, PersonalKey>> | null };
type BulkOpts = { patchFor?: (t: Task) => Partial<Task>; undoAlso?: () => void };
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Wed 30 Sep" (spelt out here: some browsers' en-GB says "Sept") */
const dayMeta = (d: Date) => `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;

/** 16:00 until the working day ends (18:00): when Today's header offers Shut down. */
const isLateDay = () => { const h = new Date().getHours(); return h >= 16 && h < 18; };

export default function App() {
  const auth = useAuth();
  const { error: toastError, success: toastSuccess, action: toastAction, toast } = useToast();
  const toastInfo = useCallback((m: string) => toast(m, "info"), [toast]);
  const toastInfoRef = useRef(toastInfo); toastInfoRef.current = toastInfo;
  // "system" follows the device (theme-init.js paints it before React mounts)
  const [theme, setTheme] = useState<ThemeChoice>(() => {
    try { const s = localStorage.getItem("kanbo-theme"); if (s === "light" || s === "dark" || s === "system") return s; } catch { /* private mode */ }
    return "dark"; // dark is the on-brand default; users can toggle to light
  });
  const systemDark = useMediaQuery("(prefers-color-scheme: dark)");
  const resolvedTheme: "light" | "dark" = theme === "system" ? (systemDark ? "dark" : "light") : theme;
  // the quick toggles (top bar, palette) always pick an explicit theme — worked out
  // when clicked, not in a state updater (StrictMode re-runs those mid-render)
  const flipTheme = useCallback(() => setTheme(resolvedThemeRef.current === "dark" ? "light" : "dark"), []);
  const [appearance, setAppearance] = useState<Appearance>(loadAppearance);
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [tags, setTags] = useState<Record<string, TagDef>>({});
  const [activity, setActivity] = useState<Activity[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [customFields, setCustomFields] = useState<CustomFieldDef[]>([]);
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>([]);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [portfolios, setPortfolios] = useState<Portfolio[]>([]);
  const [statusUpdates, setStatusUpdates] = useState<StatusUpdate[]>([]);
  const [automationRules, setAutomationRules] = useState<AutomationRule[]>([]);
  const [forms, setForms] = useState<FormDef[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([{ id: null, name: "Personal", kind: "personal" }]);
  const [wsMembers, setWsMembers] = useState<WorkspaceMember[]>([]);
  const [newWorkspaceOpen, setNewWorkspaceOpen] = useState(false);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [checkoutBusy, setCheckoutBusy] = useState<Plan | null>(null);
  const [currentUserId, setCurrentUserId] = useState("m-self");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // the section Settings was asked to open at (a deep link: ? → Shortcuts, Manage tags → Tags);
  // none for a plain open, which is Appearance on a desktop and the section list on a phone
  const [settingsSection, setSettingsSection] = useState<SettingsSection | undefined>(undefined);
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  const [calConnections, setCalConnections] = useState<CalendarConnection[]>([]);
  const [calEvents, setCalEvents] = useState<ExternalEvent[]>([]);
  const [calWarnings, setCalWarnings] = useState<CalendarWarning[]>([]);
  const calConnectionsRef = useRef(calConnections); calConnectionsRef.current = calConnections;
  const [calSyncing, setCalSyncing] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [onboardOpen, setOnboardOpen] = useState(false);
  // 0048 first run: the first-run sheet opened this session (a brand-new account: the tour may start by itself)
  const [firstRunHere, setFirstRunHere] = useState(false);
  // 0048 phone: the quick add sheet (the phone bar's +)
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  // 0048 templates: the library (and the template it opens on), Save as template (for which task), and
  // New task opened with a template applied (the library's "Use template")
  const [templateLibrary, setTemplateLibrary] = useState<{ open: boolean; initialTemplateId?: string }>({ open: false });
  const [saveTemplateFor, setSaveTemplateFor] = useState<string | null>(null);
  const [newTaskTemplate, setNewTaskTemplate] = useState<LibraryTemplate | null>(null);
  // 0048: the "Kanbo tour" sample project is being made or taken away (Help menu)
  const [sampleBusy, setSampleBusy] = useState(false);
  const [unsavedIds, setUnsavedIds] = useState<string[]>([]); // creates that failed — kept on screen until retried
  // "What moved" is for people who knew the old layout: someone who has used the app
  // in this browser before (opened My tasks or a project, or been through onboarding)
  const [knewOldLayout] = useState(() => {
    try {
      for (let i = 0; i < localStorage.length; i++) if (/^kanbo-(filters:|pview-|onboarded)/.test(localStorage.key(i) ?? "")) return true;
    } catch { /* private mode */ }
    return false;
  });
  const onboardCheckedRef = useRef(false);
  const [online, setOnline] = useState(() => (typeof navigator !== "undefined" ? navigator.onLine : true));
  const [pendingSync, setPendingSync] = useState(0); // queued offline task writes awaiting replay
  const [syncing, setSyncing] = useState(false);
  const [banner, setBanner] = useState<AppBanner | null>(null);
  const [bannerDismissed, setBannerDismissed] = useState<string | null>(() => { try { return localStorage.getItem("kanbo-banner-dismissed"); } catch { return null; } });
  // the address this page opened at, read once (the URL effects below rewrite it)
  const bootUrlRef = useRef<{ route: Route; task: string | null; q: string | null; newTask: boolean } | null>(null);
  if (!bootUrlRef.current) {
    const params = new URLSearchParams(window.location.search);
    // newTask: the installed app's "New task" shortcut (/today?new=1)
    bootUrlRef.current = { route: routeOf(window.location.pathname, window.location.search) ?? { view: "plan" }, task: params.get("task"), q: params.get("q"), newTask: params.get("new") === "1" };
  }
  const [route, setRouteRaw] = useState<Route>(() => bootUrlRef.current!.route);
  const [workspace, setWorkspace] = useState<string | null>(store.configured ? null : "ws-foundrise");
  const [view, setView] = useState<TaskView>(() => {
    try { const s = localStorage.getItem("kanbo-view") as TaskView | null; if (s && ["list", "board", "timeline", "calendar", "files", "matrix"].includes(s)) return s; } catch { /* private mode */ }
    return "list";
  });
  const [groupBy, setGroupBy] = useState<GroupBy>(() => {
    try { const s = localStorage.getItem("kanbo-groupby") as GroupBy | null; if (s && ["status", "section", "due", "priority", "project", "none"].includes(s)) return s; } catch { /* private mode */ }
    return "status";
  });
  const [smart, setSmart] = useState(false);
  const [cmdOpen, setCmdOpen] = useState(false);
  // Search opened with its text already typed in (from the palette, or ?q= in the address) until you navigate
  const [searchPrefill, setSearchPrefill] = useState<{ text: string; key: string } | null>(() => {
    const b = bootUrlRef.current!;
    return b.route.view === "search" && !b.route.list && b.q ? { text: b.q, key: "url" } : null;
  });
  // the palette opened on its Ask row (Insights' "Ask Kanbo")
  const [paletteQuery, setPaletteQuery] = useState<string | undefined>(undefined);
  const [quickCaptureOpen, setQuickCaptureOpen] = useState(false);
  const gPrefixRef = useRef(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [focusOpen, setFocusOpen] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [newTaskStatus, setNewTaskStatus] = useState<Status>("todo");
  const [newTaskProjectId, setNewTaskProjectId] = useState<string | undefined>(undefined);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [deleteProjectId, setDeleteProjectId] = useState<string | null>(null);
  // 0047: the AI project planner (a new project, or tasks added to one)
  const [planner, setPlanner] = useState<{ mode: "new" | "append"; projectId?: string; goal?: string } | null>(null);
  // 0047 approvals: the row/card chips for this workspace, and what waits on you / on others for you
  const [approvalSummaries, setApprovalSummaries] = useState<Record<string, ApprovalSummary>>({});
  const [myApprovals, setMyApprovals] = useState<MyApprovals>({ toReview: [], requested: [] });
  const isMobile = useMediaQuery("(max-width: 860px)");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const focus = useFocusTimer();
  const [aiBusy, setAiBusy] = useState(false);
  // Paste notes → tasks: open, with any text it starts from and what the notes are from
  const [extract, setExtract] = useState<{ open: boolean; text?: string; context?: string }>({ open: false });
  const [shutdownOpen, setShutdownOpen] = useState(false);
  const [weeklyOpen, setWeeklyOpen] = useState(false);
  // Month: your tasks, or the whole workspace's · Insights: yours, or the team's
  const [calScope, setCalScope] = useState<"mine" | "team">("mine");
  const [insightsScope, setInsightsScope] = useState<"me" | "team">("team");
  // bumped when this person's plan overlay (their plan on others' tasks) changes, so it's re-read
  const [overlayRev, setOverlayRev] = useState(0);
  const docked = useMediaQuery("(min-width: 1280px)");
  // Import tasks opened with text already in it (a paste too long for Quick capture)
  const [importText, setImportText] = useState<string | undefined>(undefined);
  // bumped when Inbox items are archived or brought back (Inbox › Archived lists this session's)
  const [archivedRev, setArchivedRev] = useState(0);
  // Ask's context, kept as the same object while nothing in it changes (the palette snapshots it per question)
  const askContextRef = useRef<{ key: string; value: AskContext } | null>(null);

  /* ---- live views of state for stable callbacks ---- */
  const routeRef = useRef<Route>(route); routeRef.current = route;
  const detailIdRef = useRef<string | null>(detailId); detailIdRef.current = detailId;
  const resolvedThemeRef = useRef(resolvedTheme); resolvedThemeRef.current = resolvedTheme;
  const tasksRef = useRef<Task[] | null>(null); tasksRef.current = tasks;
  // the tasks as this person sees them (their own plan on others' tasks); set where it's worked out below
  const seenRef = useRef<Task[] | null>(null);
  const userIdRef = useRef(currentUserId); userIdRef.current = currentUserId;
  const profileRef = useRef<Profile | null>(null); profileRef.current = profile;
  const projectsRef = useRef<Project[]>([]); projectsRef.current = projects;
  const sectionsRef = useRef<Section[]>([]); sectionsRef.current = sections;
  const rulesRef = useRef<AutomationRule[]>([]); rulesRef.current = automationRules;
  const tagsRef = useRef<Record<string, TagDef>>({}); tagsRef.current = tags;
  const workspacesRef = useRef<Workspace[]>([]); workspacesRef.current = workspaces;
  const workspaceRef = useRef<string | null>(null); workspaceRef.current = workspace;
  const wsMembersRef = useRef<WorkspaceMember[]>([]); wsMembersRef.current = wsMembers;
  const activityRef = useRef<Activity[]>([]); activityRef.current = activity;
  const signedInRef = useRef(false); signedInRef.current = !auth.configured || !!auth.user;

  /* ---- write bookkeeping ----
     pendingTasksRef: tasks created here that a reload hasn't returned yet, so a
       refetch can never wipe a task you just added.
     createsRef: in-flight inserts (id → server id). Writes to a task that is
       still being inserted wait for it instead of failing.
     unsavedRef: inserts that failed. The row stays on screen, flagged, with Retry.
     recentWritesRef: recent local edits/deletes, laid over a realtime refetch so
       a background reload can't revert a change whose write hasn't landed. */
  const pendingTasksRef = useRef<PendingCreate[]>([]);
  const createsRef = useRef(new Map<string, Promise<string>>());
  const unsavedRef = useRef(new Set<string>());
  const cancelledRef = useRef(new Set<string>()); // deleted before their insert ran — never insert them
  const recentWritesRef = useRef<Map<string, { deleted: boolean; patch: Partial<Task>; until: number }>>(new Map());
  const spawnedRef = useRef(new Map<string, string>()); // completed recurring task → its next occurrence
  const pendingDeletesRef = useRef(new Map<number, () => void>()); // undo-able deletes waiting to be sent
  const delSeqRef = useRef(0);
  const writeSeqRef = useRef(0);
  const fieldSeqRef = useRef(new Map<string, number>()); // `${taskId}:${field}` → newest write that set it
  const tmpOpsRef = useRef(new Map<string, { patch: Record<string, unknown>; deleted: boolean }>());
  const tmpSectionRef = useRef(new Map<string, Promise<string>>());
  const sectionAliasRef = useRef(new Map<string, string>());
  const readLocallyRef = useRef(new Map<string, string>()); // activity ids marked read here → stamp
  const lastGuestToastRef = useRef(0);
  const lastErrToastRef = useRef(0);
  const lastUnsavedToastRef = useRef(0);
  const reloadSeqRef = useRef(0);   // every bootstrap / realtime reload gets a number…
  const appliedSeqRef = useRef(0);  // …and only the newest result is ever applied
  const bootedRef = useRef(false);
  const retryUnsavedRef = useRef<() => void>(() => {});
  const removeTasksRef = useRef<(roots: Task[], label: string) => void>(() => {});
  // projects/workspaces created here → the newest reload that had already started
  // when they were created. Those reloads can't know about them, so they must not drop them.
  const recentCreatesRef = useRef(new Map<string, { seq: number; until: number }>());
  const requestReloadRef = useRef<(() => void) | null>(null); // realtime mode: ask for a fresh snapshot
  const skipWsPersistRef = useRef(false); // the next workspace change isn't the user's choice — don't remember it

  const WRITE_TTL = 8000;
  const noteWrite = useCallback((ids: string | string[], patch: Partial<Task>) => {
    const arr = Array.isArray(ids) ? ids : [ids];
    const until = Date.now() + WRITE_TTL;
    arr.forEach((id) => {
      const ex = recentWritesRef.current.get(id);
      recentWritesRef.current.set(id, { deleted: false, patch: { ...(ex && !ex.deleted ? ex.patch : {}), ...patch }, until });
    });
  }, []);
  const noteDelete = useCallback((ids: string | string[], ttl = WRITE_TTL) => {
    const arr = Array.isArray(ids) ? ids : [ids];
    const until = Date.now() + ttl;
    arr.forEach((id) => recentWritesRef.current.set(id, { deleted: true, patch: {}, until }));
  }, []);
  /** Forget a recent write (all of it, or just some fields) so a reload shows the server's value. */
  const clearWrite = useCallback((ids: string | string[], keys?: string[]) => {
    const arr = Array.isArray(ids) ? ids : [ids];
    arr.forEach((id) => {
      if (!keys) { recentWritesRef.current.delete(id); return; }
      const w = recentWritesRef.current.get(id); if (!w || w.deleted) return;
      const patch = { ...w.patch } as Record<string, unknown>;
      keys.forEach((k) => delete patch[k]);
      if (Object.keys(patch).length) recentWritesRef.current.set(id, { ...w, patch: patch as Partial<Task> });
      else recentWritesRef.current.delete(id);
    });
  }, []);
  const dropPending = useCallback((ids: Set<string>) => {
    pendingTasksRef.current = pendingTasksRef.current.filter((p) => !ids.has(p.id));
  }, []);

  /** Throttled "couldn't save" toast for writes that aren't rolled back. */
  const saveFailed = useCallback((op: string, msg = "Couldn't save that change — please try again.") => (e: unknown) => {
    reportError(e, { op });
    const now = Date.now();
    if (now - lastErrToastRef.current > 2500) { lastErrToastRef.current = now; toastError(msg); }
  }, [toastError]);

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

  /* ---- roles: guests can view and comment, nothing else ---- */
  const roleIn = useCallback((wsId: string | null | undefined): Role | null => {
    if (!wsId) return null; // Personal: your own space
    return wsMembersRef.current.find((m) => (m.workspaceId ?? null) === wsId && m.userId === userIdRef.current && m.status === "active")?.role ?? null;
  }, []);
  /** Refuse up front (with one friendly toast) instead of an optimistic change the server would silently revert. */
  const denyGuest = useCallback((wsIds: (string | null | undefined)[]): boolean => {
    if (!wsIds.some((w) => roleIn(w) === "guest")) return false;
    const now = Date.now();
    if (now - lastGuestToastRef.current > 3000) { lastGuestToastRef.current = now; toastInfo(GUEST_MSG); }
    return true;
  }, [roleIn, toastInfo]);
  const projectWs = (projectId: string | undefined) => (projectId ? getProject(projectId)?.workspaceId ?? null : null);

  /** The server gave a task a different id than we generated (only until the
   *  store inserts with explicit ids): move every local reference over. */
  const remapTaskId = useCallback((from: string, to: string) => {
    if (from === to) return;
    setTasks((ts) => ts && ts.map((x) => {
      if (x.id !== from && x.parentId !== from && !(x.dependencies ?? []).includes(from)) return x;
      return { ...x, id: x.id === from ? to : x.id, parentId: x.parentId === from ? to : x.parentId, dependencies: (x.dependencies ?? []).map((d) => (d === from ? to : d)) };
    }));
    pendingTasksRef.current = pendingTasksRef.current.map((p) => (p.id === from ? { ...p, id: to, task: { ...p.task, id: to } } : p));
    const w = recentWritesRef.current.get(from);
    if (w) { recentWritesRef.current.delete(from); recentWritesRef.current.set(to, w); }
    spawnedRef.current.forEach((v, k) => { if (v === from) spawnedRef.current.set(k, to); });
    const s = spawnedRef.current.get(from); if (s) { spawnedRef.current.delete(from); spawnedRef.current.set(to, s); }
    setDetailId((d) => (d === from ? to : d)); // an open panel follows the task
  }, []);

  useEffect(() => { store.activeBanner().then(setBanner).catch(() => {}); }, []);
  // offline write-replay queue: surface how many changes are waiting to sync
  useEffect(() => offlineQueue.subscribe(setPendingSync), []);
  // a queued create was saved: swap its optimistic id for the server's
  const onQueuedCreateSaved = useCallback((clientId: string, serverId: string, saved: Task) => {
    // after an online reopen a queued-create task isn't in state yet — insert it
    setTasks((ts) => {
      if (!ts || ts.some((t) => t.id === clientId || t.id === serverId)) return ts;
      return [{ ...saved, id: serverId }, ...ts];
    });
    remapTaskId(clientId, serverId);
  }, [remapTaskId]);
  // replay queued task writes; swap any optimistic ids the server reassigned
  const flushOffline = useCallback(async () => {
    if (offlineQueue.size() === 0 || typeof navigator !== "undefined" && navigator.onLine === false) return;
    setSyncing(true);
    try {
      const n = await store.flushQueue(onQueuedCreateSaved);
      if (n > 0) toastSuccess(`Synced ${plural(n, "offline change")}`);
    } catch (e) { reportError(e, { op: "flushOffline" }); }
    finally { setSyncing(false); }
  }, [toastSuccess, onQueuedCreateSaved]);
  // changes the queue parked after several failed tries: say so, with Retry / Discard
  const [deadLetters, setDeadLetters] = useState<DeadLetter[]>([]);
  useEffect(() => offlineQueue.subscribeDeadLetters(setDeadLetters), []);
  const retryDeadLetters = useCallback(() => { offlineQueue.retryDeadLetters(); flushOffline(); }, [flushOffline]);
  const discardDeadLetters = useCallback(() => {
    const n = offlineQueue.deadLetters().length;
    if (!n || !window.confirm(`Discard ${plural(n, "change")} that couldn't be synced? ${n === 1 ? "It's" : "They're"} only on this device, so ${n === 1 ? "it's" : "they're"} gone for good.`)) return;
    offlineQueue.discardDeadLetters();
  }, []);
  // connection awareness — honest about offline, and drain the queue on reconnect
  useEffect(() => {
    const goOnline = () => { setOnline(true); toastSuccess("Back online"); flushOffline(); };
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => { window.removeEventListener("online", goOnline); window.removeEventListener("offline", goOffline); };
  }, [toastSuccess, flushOffline]);
  // first-run onboarding: once per person (not per browser), for accounts with no real projects yet
  useEffect(() => {
    if (tasks === null || onboardCheckedRef.current) return;
    onboardCheckedRef.current = true;
    let done = false;
    try {
      const mine = `kanbo-onboarded:${userIdRef.current}`;
      done = localStorage.getItem(mine) === "1";
      // before onboarding was per person it was one flag per browser: whoever
      // signs in here first inherits it (so nobody who finished it sees it again),
      // and it's then retired so a second person on this browser still gets theirs
      if (!done && localStorage.getItem("kanbo-onboarded") === "1") {
        done = true;
        localStorage.setItem(mine, "1"); localStorage.removeItem("kanbo-onboarded");
      }
    } catch { /* private mode */ }
    if (!done && projectsRef.current.filter((p) => p.id !== "p-personal").length === 0) { setOnboardOpen(true); setFirstRunHere(true); }
  }, [tasks]);
  // (the sheet hands over to the guided tour, which shows the real places — "What moved" has nothing to add)
  const finishOnboarding = useCallback(() => { try { localStorage.setItem(`kanbo-onboarded:${userIdRef.current}`, "1"); } catch { /* ignore */ } markWhatMovedSeen(); setOnboardOpen(false); }, []);

  // My tasks' view and grouping (a project's are its own, below)
  useEffect(() => { try { localStorage.setItem("kanbo-view", view); } catch { /* private mode */ } }, [view]);
  useEffect(() => { try { localStorage.setItem("kanbo-groupby", groupBy); } catch { /* private mode */ } }, [groupBy]);
  // each project's view and grouping, remembered per project. The address is the source of
  // truth for the view (/p/:id/board); this is where a bare /p/:id goes next time. Opening a
  // project never changes how My tasks looks, and a project never inherits My tasks' view.
  const [projectPrefs, setProjectPrefs] = useState<Record<string, ProjectPrefs>>({});
  const openProjectId = route.view === "project" ? route.projectId : undefined;
  const openPrefs: ProjectPrefs | null = openProjectId ? projectPrefs[openProjectId] ?? readProjectPrefs(openProjectId) : null;
  const saveProjectPrefs = useCallback((id: string, patch: Partial<ProjectPrefs>) => {
    setProjectPrefs((m) => {
      const cur = m[id] ?? readProjectPrefs(id);
      if (Object.entries(patch).every(([k, v]) => cur[k as keyof ProjectPrefs] === v)) return m;
      const next = { ...cur, ...patch };
      try { localStorage.setItem(projectPrefsKey(id), JSON.stringify(next)); } catch { /* private mode */ }
      return { ...m, [id]: next };
    });
  }, []);
  // the view in the address is the one this project was last shown in
  useEffect(() => {
    if (openProjectId && isTaskView(route.tab)) saveProjectPrefs(openProjectId, { view: route.tab });
  }, [openProjectId, route.tab, saveProjectPrefs]);

  /* ---- 0047 approvals: chips on rows and cards, the Inbox group, Waiting on approval ---- */
  // Approvals need a team task, so Personal has none. A failure keeps what's on screen
  // (before 0047 the lib answers {} / nothing waiting).
  const approvalsReady = !!tasks;
  const approvalsSeqRef = useRef(0);
  const refreshApprovalSummaries = useCallback(() => {
    const ws = workspaceRef.current, seq = ++approvalsSeqRef.current;
    if (!ws) { setApprovalSummaries({}); return; }
    listApprovalSummaries(ws).then((m) => { if (seq === approvalsSeqRef.current && workspaceRef.current === ws) setApprovalSummaries(m); }, (e) => reportError(e, { op: "listApprovalSummaries" }));
  }, []);
  const refreshMyApprovals = useCallback(() => {
    // before 0047 nothing waits on anyone: not an error worth reporting
    listMyApprovals().then(setMyApprovals, (e) => { if (approvalFailure(e) !== "unavailable") reportError(e, { op: "listMyApprovals" }); });
  }, []);
  useEffect(() => {
    if (!approvalsReady) return;
    refreshApprovalSummaries();
    refreshMyApprovals();
  }, [approvalsReady, workspace, currentUserId, refreshApprovalSummaries, refreshMyApprovals]);
  useEffect(() => {
    if (!approvalsReady) return;
    let timer: number | undefined;
    // a burst of changes (a request names several reviewers) refreshes once
    const unsub = subscribeApprovals(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { refreshApprovalSummaries(); refreshMyApprovals(); }, 500);
    });
    return () => { window.clearTimeout(timer); unsub(); };
  }, [approvalsReady, refreshApprovalSummaries, refreshMyApprovals]);
  const onApprovalsChange = useCallback(() => { refreshApprovalSummaries(); refreshMyApprovals(); }, [refreshApprovalSummaries, refreshMyApprovals]);

  /* ---- inbox: scoped to the active workspace; the badge is the server's read_at ---- */
  const scopedActivity = useMemo(() => {
    if (!tasks) return [] as Activity[];
    // a task's activity belongs to the workspace its task lives in, so personal
    // activity never leaks into a team inbox (or vice versa). Unresolvable
    // (deleted-task) items are dropped. Integration notices (a webhook switched
    // off) have no task: they're about your own setup, so every inbox shows them.
    // A doc @mention (0047) has no task either: it belongs to its project's workspace.
    const wsOfTask = new Map(tasks.map((t) => [t.id, t.workspaceId ?? null]));
    return activity.filter((a) => (a.kind === "integration" && a.taskId == null)
      || (a.taskId != null && wsOfTask.has(a.taskId) && wsOfTask.get(a.taskId) === workspace)
      || (a.kind === "doc_mention" && docMentionInWorkspace(a, projects, workspace)));
  }, [tasks, activity, workspace, projects]);
  const scopedActivityRef = useRef<Activity[]>([]); scopedActivityRef.current = scopedActivity;
  // unread = not read on the server (any device), and not your own actions
  const inboxCount = scopedActivity.filter((a) => !a.readAt && !SELF_KINDS.has(a.kind)).length;
  const mergeReadState = useCallback((feed: Activity[]) =>
    feed.map((a) => (a.readAt || !readLocallyRef.current.has(a.id) ? a : { ...a, readAt: readLocallyRef.current.get(a.id) })), []);
  useEffect(() => {
    if (route.view !== "inbox") return;
    try { localStorage.setItem(`kanbo-inbox-seen:${userIdRef.current}`, String(Date.now())); } catch { /* private mode */ }
  }, [route.view]);
  // while the inbox is on screen, what it shows (this workspace only) is read —
  // including anything that arrives while you're looking at it
  // On the Inbox, "new" is what the list shows as new: what was unread when this visit
  // began (or landed during it), less what you've opened, archived or snoozed since. The
  // page header, the sidebar and phone badges and the tab title all show that one number
  // (InboxView reports it), so they fall together and reach zero at Inbox zero. Anywhere
  // else it's the unread count; leaving the Inbox, what you saw there has been read.
  const [inboxLiveNew, setInboxLiveNew] = useState<number | null>(null);
  useEffect(() => { if (route.view !== "inbox") setInboxLiveNew(null); }, [route.view]);
  const newCount = route.view === "inbox" && inboxLiveNew !== null ? inboxLiveNew : inboxCount;
  useEffect(() => {
    if (route.view !== "inbox") return;
    const unread = scopedActivity.filter((a) => !a.readAt).map((a) => a.id);
    if (!unread.length) return;
    const stamp = new Date().toISOString();
    const ids = new Set(unread);
    unread.forEach((id) => readLocallyRef.current.set(id, stamp));
    setActivity((xs) => xs.map((a) => (ids.has(a.id) && !a.readAt ? { ...a, readAt: stamp } : a)));
    store.markActivityRead(unread).catch(reportError);
  }, [route.view, scopedActivity]);
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", resolvedTheme);
    try { localStorage.setItem("kanbo-theme", theme); } catch { /* private mode */ }
    // (theme-init.js keeps <meta name="theme-color"> in step with data-theme)
  }, [theme, resolvedTheme]);
  useEffect(() => { saveAppearance(appearance); }, [appearance]);

  /* ---- keyboard ---- */
  const overlayRef = useRef({ quick: false, cmd: false, upgrade: false, deleteProject: false, newWorkspace: false, newProject: false, newTask: false, focus: false, detail: false, sidebar: false, selfManaged: false });
  overlayRef.current = {
    quick: quickCaptureOpen, cmd: cmdOpen, upgrade: upgradeOpen, deleteProject: !!deleteProjectId,
    newWorkspace: newWorkspaceOpen, newProject: newProjectOpen, newTask: newTaskOpen, focus: focusOpen, detail: !!detailId, sidebar: sidebarOpen,
    // these dialogs handle Escape themselves; the window handler must leave them (and what's under them) alone
    selfManaged: settingsOpen || importOpen || welcomeOpen || onboardOpen || quickAddOpen || templateLibrary.open || !!saveTemplateFor,
  };
  const openNewTaskRef = useRef<() => void>(() => {});
  const openCaptureRef = useRef<() => void>(() => {});
  const openSettingsRef = useRef<(s?: SettingsSection) => void>(() => {});
  const openFocusRef = useRef<(start?: boolean) => void>(() => {});
  const goRef = useRef<(r: Route) => void>(() => {});
  useEffect(() => {
    const isEditable = (el: EventTarget | null) => {
      const h = el as HTMLElement | null;
      return !!h && (h.tagName === "INPUT" || h.tagName === "TEXTAREA" || h.tagName === "SELECT" || h.isContentEditable);
    };
    const h = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;      // a field, menu or dialog already handled it
      if (!signedInRef.current) return;    // no app shortcuts on the signed-out site
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.altKey && e.key.toLowerCase() === "k") { e.preventDefault(); setCmdOpen((v) => !v); return; }
      const modal = () => !!document.querySelector('[aria-modal="true"]');
      if (mod && !e.altKey && !e.shiftKey && e.key === ",") {
        e.preventDefault(); // never the browser's own settings, even while a dialog is up
        if (!modal()) openSettingsRef.current();
        return;
      }
      // ⌘Z: take back the newest undoable change, wherever you are (the task panel
      // and the ritual sheets included). Only a text field keeps ⌘Z for its own undo.
      if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "z") {
        if (isEditable(e.target)) return;
        e.preventDefault();
        const label = undoLast();
        toastInfoRef.current(label ? `Undone: ${label}` : "Nothing to undo");
        return;
      }
      if (e.key === "Escape") {
        // close only the top-most overlay — never the task panel underneath a menu
        const o = overlayRef.current;
        if (o.selfManaged) return;
        const editable = isEditable(e.target);
        if (o.quick) setQuickCaptureOpen(false);
        else if (o.cmd) setCmdOpen(false);
        else if (o.upgrade) setUpgradeOpen(false);
        else if (o.deleteProject) setDeleteProjectId(null);
        else if (o.newWorkspace) setNewWorkspaceOpen(false);
        else if (o.newProject) setNewProjectOpen(false);
        else if (o.newTask) setNewTaskOpen(false);
        else if (o.focus) setFocusOpen(false);
        // typing in the task panel: leave the field, keep the panel (and your draft).
        // Only the panel's own fields — elsewhere a field's Escape is its own business
        // (an inline "Add task" treats Escape as cancel and blur as save).
        else if (o.detail) {
          const inPanel = editable && !!(e.target as HTMLElement).closest?.('[role="dialog"][aria-label^="Task:"]');
          if (inPanel) (e.target as HTMLElement).blur(); else setDetailId(null);
        }
        else if (o.sidebar) setSidebarOpen(false);
        return;
      }
      // single-key shortcuts — never while typing, with modifiers held, or while a dialog is open
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditable(e.target)) return;
      if (modal()) { gPrefixRef.current = false; return; }
      if (gPrefixRef.current) {
        gPrefixRef.current = false;
        const to = G_KEYS[e.key.toLowerCase()];
        if (to) { e.preventDefault(); goRef.current(to); }
        return;
      }
      if (e.key === "g") { gPrefixRef.current = true; window.setTimeout(() => { gPrefixRef.current = false; }, 800); return; }
      if (e.key === "c") { e.preventDefault(); openNewTaskRef.current(); return; }
      if (e.key === "q") { e.preventDefault(); openCaptureRef.current(); return; }
      if (e.key === "f") { e.preventDefault(); openFocusRef.current(true); return; }
      if (e.key === "/") { e.preventDefault(); setCmdOpen(true); return; }
      if (e.key === "?") { e.preventDefault(); openSettingsRef.current("shortcuts"); return; }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  // mobile drawer: out of the tab order and hidden from assistive tech while closed;
  // focus moves in when it opens and back to where you were when it closes
  const drawerRef = useRef<HTMLDivElement>(null);
  const drawerReturnRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = drawerRef.current; if (!el) return;
    if (sidebarOpen) {
      el.removeAttribute("inert");
      drawerReturnRef.current = document.activeElement as HTMLElement | null;
      el.querySelector<HTMLElement>('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')?.focus();
    } else {
      el.setAttribute("inert", "");
      const back = drawerReturnRef.current; drawerReturnRef.current = null;
      if (back && document.contains(back)) back.focus();
    }
  }, [sidebarOpen, isMobile, tasks === null]);

  // load data once the user is known (immediately in demo mode)
  const authUserId = auth.user?.id ?? null;

  // dwell-time tracking: open a session and heartbeat while the tab is active
  // (best-effort — quietly no-ops if the sessions table isn't installed yet)
  useEffect(() => {
    if (!store.configured || !authUserId) return;
    let sessionId: string | null = null, stopped = false;
    store.recordSession(authUserId).then((id) => { sessionId = id; });
    const beat = () => { if (!stopped && sessionId && document.visibilityState === "visible") store.touchSession(sessionId); };
    const iv = window.setInterval(beat, 45000);
    document.addEventListener("visibilitychange", beat);
    return () => { stopped = true; clearInterval(iv); document.removeEventListener("visibilitychange", beat); };
  }, [authUserId]);

  /** Server tasks + what the server can't know yet: recent local edits/deletes and
   *  tasks created here that it hasn't returned (kept by id, in their current local form). */
  const mergeServerTasks = useCallback((serverTasks: Task[]): Task[] => {
    const now = Date.now();
    const m = recentWritesRef.current;
    for (const [id, w] of m) if (w.until < now) m.delete(id);
    const merged = serverTasks
      .filter((d) => !m.get(d.id)?.deleted)
      .map((d) => { const w = m.get(d.id); return w && !w.deleted ? { ...d, ...w.patch } : d; });
    const serverIds = new Set(serverTasks.map((d) => d.id));
    const queued = new Set(offlineQueue.all().flatMap((q) => (q.kind === "create" ? [q.task.id] : [])));
    pendingTasksRef.current = pendingTasksRef.current.filter((p) => !serverIds.has(p.id) && (p.until === null || p.until > now || queued.has(p.id)));
    const local = new Map((tasksRef.current ?? []).map((t) => [t.id, t]));
    const pending = pendingTasksRef.current.filter((p) => !m.get(p.id)?.deleted).map((p) => local.get(p.id) ?? p.task);
    return pending.length ? [...pending, ...merged] : merged;
  }, []);

  /** A project or workspace was just created here: reloads already under way keep it. */
  const noteCreated = useCallback((id: string) => {
    recentCreatesRef.current.set(id, { seq: reloadSeqRef.current, until: Date.now() + 30000 });
  }, []);

  /** Once per session, and only to a platform admin (the one person who can act on
   *  it): the database is missing columns this version writes (a migration not run
   *  yet), so some fields are being dropped on save. Everyone else's drops still
   *  reach monitoring (the store reports each column once). */
  const schemaNoticeRef = useRef(false);
  const noteSchemaBehind = useCallback((adminByProfile: boolean) => {
    if (schemaNoticeRef.current || !store.configured || getStrippedColumns().length === 0) return;
    schemaNoticeRef.current = true;
    const tell = () => {
      const cols = getStrippedColumns();
      toastInfo(`Admin notice: the database is behind this version — ${cols.join(", ")} ${cols.length === 1 ? "isn't" : "aren't"} being saved yet. Run the pending migration.`);
    };
    if (adminByProfile) { tell(); return; }
    // the founding account may not carry the profile flag — ask the server (once, and only now)
    store.amIAdmin().then((admin) => { if (admin) tell(); }, () => { /* not an admin as far as we can tell */ });
  }, [toastInfo]);

  /** Apply a bootstrap result. Returns false when a newer run's data is already on screen. */
  const applyBoot = useCallback((loaded: Bootstrap, seq: number, initial: boolean): boolean => {
    if (initial) {
      setCurrentUserId(loaded.currentUserId);
      // reopen where this person left off (if they're still in that workspace)
      let stored: string | null = null;
      try { stored = localStorage.getItem(lastWorkspaceKey(loaded.currentUserId)); } catch { /* private mode */ }
      setWorkspace(pickStartWorkspace(loaded.workspaces, loaded.defaultWorkspace, stored));
      // where we open isn't a choice to remember (a list that loaded short would otherwise pin Personal)
      skipWsPersistRef.current = true;
      bootedRef.current = true;
    }
    if (seq < appliedSeqRef.current) {
      // the store already pointed its lookups at this older snapshot — point them back at what's on screen
      setReferenceData({ projects: projectsRef.current, workspaces: workspacesRef.current, tags: tagsRef.current });
      return false;
    }
    appliedSeqRef.current = seq;
    // a reload where some best-effort parts failed keeps what's on screen for those
    // parts. (The first load's parts are already the device's last good copy.)
    const b = initial ? loaded : keepOnScreen(loaded, { projects: projectsRef.current, tags: tagsRef.current, workspaces: workspacesRef.current, members: wsMembersRef.current });
    noteSchemaBehind(!!b.profile?.isAdmin && b.profile.suspended !== true);
    setTasks(mergeServerTasks(b.tasks));
    const tmpTags = Object.fromEntries(Object.entries(tagsRef.current).filter(([k]) => k.startsWith("tmp-")));
    // Projects and workspaces this snapshot can't be trusted to leave out: ones created
    // here after the reload started, and — when a best-effort query came back short —
    // ones the rest of the snapshot still vouches for. Everything else follows the server.
    const justMade = unseenCreates(recentCreatesRef.current, seq);
    applyProjects(reloadProjects(b.projects, projectsRef.current, b.tasks, justMade)); applyTags({ ...b.tags, ...tmpTags });
    const ws = reloadWorkspaces(b.workspaces, workspacesRef.current, b.members, wsMembersRef.current, b.currentUserId, justMade);
    setWorkspaces(ws.workspaces); setReferenceData({ workspaces: ws.workspaces });
    setWsMembers(ws.members); setProfile((cur) => (!initial && b.partial?.profile ? cur : b.profile));
    setSections((cur) => keepTmp(b.sections, cur)); setCustomFields((cur) => keepTmp(b.customFields, cur)); setSavedSearches((cur) => keepTmp(b.savedSearches, cur));
    setGoals((cur) => keepTmp(b.goals, cur)); setPortfolios((cur) => keepTmp(b.portfolios, cur)); setStatusUpdates(b.statusUpdates);
    setAutomationRules((cur) => keepTmp(b.automationRules, cur)); setForms((cur) => keepTmp(b.forms, cur));
    return true;
  }, [mergeServerTasks, applyProjects, applyTags, noteSchemaBehind]);

  useEffect(() => {
    if (auth.configured && !authUserId) {
      // signed out: nothing from the last session may leak into the next one
      setTasks(null); bootedRef.current = false; onboardCheckedRef.current = false;
      pendingTasksRef.current = []; createsRef.current.clear(); unsavedRef.current.clear(); setUnsavedIds([]);
      recentWritesRef.current.clear(); spawnedRef.current.clear(); readLocallyRef.current.clear(); archivedHereRef.current.clear();
      // (0048: the Inbox's thread snoozes are kept per person; nothing of this one's stays for the next)
      void import("./components/inbox/useThreadSnoozes").then((m) => m.forgetSnoozeCache(), () => undefined);
      return;
    }
    let cancelled = false;
    const seq = ++reloadSeqRef.current;
    // retries the store schedules by itself (a request that died mid-flight) can
    // swap optimistic ids too, even when the queue was empty at load
    store.setRemapHandler(onQueuedCreateSaved);
    (async () => {
      try {
        const b = await store.bootstrap(auth.user);
        if (cancelled) return;
        applyBoot(b, seq, true);
        flushOffline(); // app reopened online after offline edits — drain the queue
        const feed = await store.listActivity();
        if (!cancelled && seq >= appliedSeqRef.current) setActivity(mergeReadState(feed));
        const subn = await store.getSubscription();
        if (!cancelled) setSubscription(subn);
      } catch (e) {
        reportError(e, { op: "bootstrap" });
        if (!cancelled) { setTasks([]); toastError("Couldn't load your workspace. Please refresh."); }
      }
    })();
    return () => { cancelled = true; store.setRemapHandler(null); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.configured, authUserId]);

  // real-time multi-tab/device sync: re-pull data on remote changes. 500ms
  // trailing debounce with a 3s max wait (steady traffic can't starve it), and
  // numbered runs so an older reload that finishes late can't overwrite a newer one.
  // One reload at a time: events that arrive while one runs queue a single follow-up.
  // A resync (reconnected, back online, tab back after a while) runs at once; a
  // change that only touches the inbox (activity rows) re-reads just the feed.
  useEffect(() => {
    if (!store.configured || !authUserId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let feedTimer: ReturnType<typeof setTimeout> | undefined;
    let firstAt = 0, alive = true, running = false, dirty = false;
    const reload = async () => {
      if (running) { dirty = true; return; }
      running = true;
      const seq = ++reloadSeqRef.current;
      try {
        const b = await store.bootstrap(auth.user);
        if (!alive || !applyBoot(b, seq, false)) return;
        const feed = await store.listActivity();
        if (alive && seq >= appliedSeqRef.current) setActivity(mergeReadState(feed));
      } catch (e) { reportError(e, { op: "realtime-reload" }); }
      finally {
        running = false;
        if (dirty && alive) { dirty = false; schedule(); }
      }
    };
    const schedule = () => {
      const now = Date.now();
      if (!firstAt) firstAt = now;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { firstAt = 0; timer = undefined; reload(); }, Math.max(0, Math.min(500, firstAt + 3000 - now)));
    };
    const reloadNow = () => { if (timer) clearTimeout(timer); timer = undefined; firstAt = 0; reload(); };
    const refreshFeed = () => {
      if (feedTimer) return; // one feed read per burst
      feedTimer = setTimeout(() => {
        feedTimer = undefined;
        const seq = appliedSeqRef.current;
        store.listActivity().then((feed) => { if (alive && seq === appliedSeqRef.current) setActivity(mergeReadState(feed)); }, (e) => reportError(e, { op: "realtime-feed" }));
      }, 400);
    };
    const onChange = (change?: RealtimeChange) => {
      if (change?.kind === "resync") reloadNow();
      else if (change?.kind === "row" && change.table === "activity") refreshFeed();
      else schedule();
    };
    requestReloadRef.current = schedule;
    const unsub = store.subscribeToChanges(onChange);
    return () => { alive = false; requestReloadRef.current = null; if (timer) clearTimeout(timer); if (feedTimer) clearTimeout(feedTimer); unsub(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUserId]);

  /* ---- addresses: every route has a real URL, and Back / Forward work ----
     setRoute pushes one history entry per user action (a redirect in the same
     tick replaces it); the effect by the loading gates keeps the address in
     step with anything else (the open task, a project's real id, a guard). */
  const pushedThisTickRef = useRef(false);
  const shellShownRef = useRef(false);
  // Phones scroll the whole page (the app root), so a new page has to start at its
  // top, and Back / Forward return to where you were: each history entry keeps its
  // scroll position, and this says where the page should sit after the next render.
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollToRef = useRef<number | null>(null);
  const writeUrl = useCallback((url: string, mode: "push" | "replace") => {
    if (url === window.location.pathname + window.location.search) return;
    try {
      if (mode === "push" && !pushedThisTickRef.current) {
        // the entry you're leaving remembers how far down you were
        window.history.replaceState({ ...(window.history.state ?? {}), kScroll: rootRef.current?.scrollTop ?? 0 }, "");
        window.history.pushState({}, "", url);
        pushedThisTickRef.current = true;
        queueMicrotask(() => { pushedThisTickRef.current = false; });
      } else window.history.replaceState(window.history.state, "", url);
    } catch { /* a sandboxed frame: everything works, just without addresses */ }
  }, []);

  /** Go somewhere. Closes the task panel (unless `keepPanel`: a tab switch on
   *  the same page) and the phone drawer; `replace` for redirects Back shouldn't revisit. */
  const setRoute = useCallback((to: Route, opts: { replace?: boolean; keepPanel?: boolean } = {}) => {
    const wsId = workspaceRef.current;
    const r = bootedRef.current ? normaliseRoute(to, { personal: wsId === null, guest: roleIn(wsId) === "guest" }) : to;
    if (!sameRoute(r, routeRef.current)) scrollToRef.current = 0; // a new page or tab starts at its top
    setRouteRaw(r);
    setSearchPrefill(null);
    if (r.smart) setSmart(true);
    if (!opts.keepPanel) setDetailId(null);
    setSidebarOpen(false); // close the mobile drawer on navigation
    if (shellShownRef.current) writeUrl(addressFor(r, { task: opts.keepPanel ? detailIdRef.current : null }), opts.replace ? "replace" : "push");
  }, [writeUrl, roleIn]);
  goRef.current = setRoute;
  // the palette's Recent: the last five places you went, and the tasks you last opened, newest first (in memory only)
  const recentRoutesRef = useRef<Route[]>([]);
  useEffect(() => {
    recentRoutesRef.current = [route, ...recentRoutesRef.current.filter((r) => !sameRoute(r, route))].slice(0, 5);
  }, [route]);
  const recentTaskIdsRef = useRef<string[]>([]);
  useEffect(() => {
    if (detailId) recentTaskIdsRef.current = [detailId, ...recentTaskIdsRef.current.filter((id) => id !== detailId)].slice(0, 5);
  }, [detailId]);

  // Back / Forward: follow the address. Overlays close; the task panel stays.
  useEffect(() => {
    const onPop = () => {
      if (!shellShownRef.current) return;
      const params = new URLSearchParams(window.location.search);
      const wsId = workspaceRef.current;
      const r = normaliseRoute(routeOf(window.location.pathname, window.location.search) ?? { view: "plan" }, { personal: wsId === null, guest: roleIn(wsId) === "guest" });
      const saved = (window.history.state as { kScroll?: unknown } | null)?.kScroll;
      scrollToRef.current = typeof saved === "number" ? saved : 0;
      setRouteRaw(r);
      const q = params.get("q");
      setSearchPrefill(r.view === "search" && !r.list && q ? { text: q, key: `url-${Date.now()}` } : null);
      setCmdOpen(false); setQuickCaptureOpen(false); setNewTaskOpen(false); setNewProjectOpen(false); setNewWorkspaceOpen(false);
      setImportOpen(false); setSettingsOpen(false); setSettingsSection(undefined); setUpgradeOpen(false); setDeleteProjectId(null); setFocusOpen(false);
      setExtract({ open: false }); setShutdownOpen(false); setWeeklyOpen(false); setSidebarOpen(false);
      setQuickAddOpen(false); setTemplateLibrary({ open: false }); setSaveTemplateFor(null);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [roleIn]);
  // …and once the new page is on screen, put the phone's page scroll where it belongs
  // (before paint, so the old position never shows). Desktop views scroll on their own.
  useLayoutEffect(() => {
    const top = scrollToRef.current;
    if (top === null) return;
    scrollToRef.current = null;
    const el = rootRef.current;
    if (!el || el.scrollTop === top) return;
    el.scrollTop = top;
    // a page that's still filling in (its header settling, a notice arriving) can be
    // too short for the spot on the first pass: try again once it has laid out
    if (el.scrollTop < top) requestAnimationFrame(() => requestAnimationFrame(() => { if (el.scrollTop < top) el.scrollTop = top; }));
  }, [route]);

  // remember the workspace per person, so the next visit opens where they left off
  // (only the user's own switches — not where we opened, nor a switch we forced)
  useEffect(() => {
    if (tasks === null || !bootedRef.current) return;
    if (store.configured && currentUserId === "m-self") return;
    if (skipWsPersistRef.current) { skipWsPersistRef.current = false; return; }
    try { localStorage.setItem(lastWorkspaceKey(currentUserId), workspace ?? "personal"); } catch { /* private mode */ }
  }, [workspace, currentUserId, tasks === null]);

  // you left / were removed from a workspace, or it was closed: don't stay pointed at it.
  // A reload can come back short (a failed best-effort query), so the membership is
  // checked directly before anyone is moved — and nothing happens if that check fails.
  const wsNamesRef = useRef(new Map<string | null, string>());
  const wsCheckRef = useRef<string | null>(null);
  useEffect(() => {
    if (tasks === null) return;
    workspaces.forEach((w) => wsNamesRef.current.set(w.id, w.name));
    if (workspace === null || workspaces.some((w) => w.id === workspace)) return;
    const gone = workspace;
    if (wsCheckRef.current === gone) return; // already checking
    wsCheckRef.current = gone;
    const me = userIdRef.current;
    const check = store.configured
      ? store.listWorkspaceMembers().then((ms) => !ms.some((m) => (m.workspaceId ?? null) === gone && m.userId === me && m.status === "active"))
      : Promise.resolve(true);
    check.then((isGone) => {
      if (!isGone || workspaceRef.current !== gone || workspacesRef.current.some((w) => w.id === gone)) return;
      const name = wsNamesRef.current.get(gone);
      skipWsPersistRef.current = true;
      setWorkspace(null); setRoute({ view: "plan" }, { replace: true });
      toastInfo(name ? `You're no longer in ${name}` : "You're no longer in that workspace");
    }, (e) => reportError(e, { op: "confirmWorkspaceGone" })) // couldn't check: stay put, the next reload looks again
      .finally(() => { if (wsCheckRef.current === gone) wsCheckRef.current = null; });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaces, workspace, tasks === null]);
  // The open project was deleted, archived or moved to another workspace: go to Today.
  // "Missing" must show up in two reloads in a row before it counts (one can come back short).
  // Arriving at a project that lives in another workspace (an address, Back, a link)
  // follows it there instead; `seen` tells arriving apart from the workspace changing under it.
  const projMissRef = useRef<{ id: string; seq: number } | null>(null);
  const routeWsRef = useRef<string | null>(null);
  const projSeenRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const switched = routeWsRef.current !== workspace; routeWsRef.current = workspace;
    if (tasks === null) return;
    if (route.view !== "project" || !route.projectId || route.projectId.startsWith("tmp-")) { projMissRef.current = null; projSeenRef.current = route.projectId; return; }
    const pid = route.projectId;
    const arrived = projSeenRef.current !== pid; projSeenRef.current = pid;
    const p = projects.find((x) => x.id === pid);
    if (!p) {
      const miss = projMissRef.current;
      if (requestReloadRef.current && (!miss || miss.id !== pid)) { projMissRef.current = { id: pid, seq: appliedSeqRef.current }; requestReloadRef.current(); return; }
      if (requestReloadRef.current && miss && appliedSeqRef.current <= miss.seq) return; // wait for the confirming reload
      projMissRef.current = null;
      setRoute({ view: "plan" }, { replace: true }); toastInfo("That project was deleted, or you no longer have access to it.");
      return;
    }
    projMissRef.current = null;
    // (only people who can archive see the sidebar's Restore)
    if (p.archivedAt) { setRoute({ view: "plan" }, { replace: true }); toastInfo(canArchiveProject(p, { myRole: roleIn(p.workspaceId) }) ? `“${p.name}” was archived — restore it from the sidebar.` : `“${p.name}” was archived.`); }
    else if ((p.workspaceId ?? null) !== workspace) {
      if (arrived) { setWorkspace(p.workspaceId ?? null); return; }
      setRoute({ view: "plan" }, { replace: true });
      // you switched workspace: nothing to explain. Otherwise (it was moved): say where it is.
      if (!switched) toastInfo(`“${p.name}” is now in ${workspaces.find((w) => w.id === (p.workspaceId ?? null))?.name || "Personal"} — switch workspace to open it.`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, projects, workspace, tasks === null]);
  // The page has to make sense for who you are here, however you arrived (an address,
  // Back, a g-key, a workspace switch, a role change): Personal's /team is Insights, and
  // a guest opening Rules lands on Projects (or the project) instead. setRoute and Back
  // already ask; this catches the first address and the workspace or role changing.
  useEffect(() => {
    if (tasks === null) return;
    const n = normaliseRoute(route, { personal: workspace === null, guest: roleIn(workspace) === "guest" });
    if (!sameRoute(n, route)) setRoute(n, { replace: true, keepPanel: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, workspace, wsMembers, tasks === null]);

  /* append to the activity feed (Inbox) — fire-and-forget */
  const log = useCallback((kind: ActivityKind, task: { id: string | null; title: string }, detail: string) => {
    store.logActivity({ taskId: task.id, taskTitle: task.title, kind, detail }, userIdRef.current)
      .then((a) => setActivity((xs) => [a, ...xs]))
      .catch(reportError);
  }, []);

  /* ---- inbox archiving (with Undo) ---- */
  // what was archived on this visit (Inbox › Archived can move it back), with its archive's save
  const archivedHereRef = useRef(new Map<string, { item: Activity; archived: Promise<void> }>());
  const putBackActivity = useCallback((items: Activity[]) => {
    setActivity((xs) => {
      const have = new Set(xs.map((a) => a.id));
      const back = items.filter((a) => !have.has(a.id));
      return back.length ? [...back, ...xs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : xs;
    });
  }, []);
  /** Undo archives: back on screen at once, and un-archived on the server (in one
   *  call) once each archive has landed — one that failed already put its items back. */
  const undoArchive = useCallback((parts: ArchivePart[]) => {
    const items = parts.flatMap((p) => p.items);
    if (!items.length) return;
    items.forEach((a) => archivedHereRef.current.delete(a.id));
    setArchivedRev((n) => n + 1);
    putBackActivity(items);
    Promise.all(parts.map((p) => p.archived.then(() => p.items.map((a) => a.id), () => [] as string[]))).then((landed) => {
      const ids = landed.flat();
      if (!ids.length) return;
      return store.unarchiveActivity(ids).catch((e) => {
        reportError(e, { op: "unarchiveActivity" });
        const gone = new Set(ids);
        setActivity((xs) => xs.filter((a) => !gone.has(a.id)));
        toastError(ids.length === 1 ? "Couldn't bring that item back." : "Couldn't bring those items back.");
      });
    });
  }, [putBackActivity, toastError]);

  /** The inbox keeps ONE Undo toast: archiving more while it's up adds to it
   *  ("Archived 3 notifications") and its Undo brings them all back, so working
   *  through the inbox never stacks toasts over its rows. */
  const archiveBatchRef = useRef<ArchivePart[] | null>(null);
  const offerArchiveUndo = useCallback((part: ArchivePart, message: string) => {
    const prev = archiveBatchRef.current;
    const batch = [...(prev ?? []), part];
    archiveBatchRef.current = batch;
    const done = () => { if (archiveBatchRef.current === batch) archiveBatchRef.current = null; };
    const n = batch.reduce((sum, p) => sum + p.items.length, 0);
    toastAction(prev ? `Archived ${plural(n, "notification")}` : message, "Undo", () => { done(); undoArchive(batch); }, { key: "inbox-archive", onExpire: done });
  }, [toastAction, undoArchive]);

  const noteArchived = useCallback((items: Activity[], archived: Promise<void>) => {
    items.forEach((item) => archivedHereRef.current.set(item.id, { item, archived }));
    setArchivedRev((n) => n + 1);
    // it's back in the inbox
    archived.catch(() => { items.forEach((a) => archivedHereRef.current.delete(a.id)); setArchivedRev((n) => n + 1); });
  }, []);

  const archiveActivity = useCallback((id: string) => {
    const removed = activityRef.current.filter((a) => a.id === id);
    setActivity((xs) => xs.filter((a) => a.id !== id)); // optimistic
    const archived = store.archiveActivity(id);
    archived.catch((e) => { reportError(e); toastError("Couldn't archive that item."); putBackActivity(removed); });
    noteArchived(removed, archived);
    offerArchiveUndo({ items: removed, archived }, "Notification archived");
  }, [toastError, putBackActivity, offerArchiveUndo, noteArchived]);

  // "Archive all" clears what the inbox is showing — this workspace, not every workspace
  const clearInbox = useCallback((ids?: unknown) => {
    const list = Array.isArray(ids) ? (ids as string[]) : scopedActivityRef.current.map((a) => a.id);
    if (!list.length) return;
    const set = new Set(list);
    const removed = activityRef.current.filter((a) => set.has(a.id));
    setActivity((xs) => xs.filter((a) => !set.has(a.id)));
    const archived = store.clearInbox(list);
    archived.catch((e) => { reportError(e); toastError("Couldn't clear the inbox."); putBackActivity(removed); });
    noteArchived(removed, archived);
    offerArchiveUndo({ items: removed, archived }, Array.isArray(ids) ? `Archived ${plural(list.length, "item")}` : "Inbox cleared");
  }, [toastError, putBackActivity, offerArchiveUndo, noteArchived]);

  /* ---- profile ---- */
  const uploadAvatar = useCallback((file: File) => store.uploadAvatar(userIdRef.current, file), []);

  // leave avatarUrl out to keep the saved photo (a stale copy of the profile —
  // another tab, or before the photo loaded — must not put an old one back)
  const saveProfile = useCallback(async (draft: Omit<ProfileDraft, "avatarUrl"> & { avatarUrl?: string | null }) => {
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

  // The In-app / Email table and the push panel hand over the whole prefs object: only what changed is sent
  // (merge_notify_prefs, 0048; null removes a key), so a stale tab never overwrites another device's change.
  // Demo mode, and a database without 0048, save the whole object as before.
  const saveNotifyPrefs = useCallback((prefs: NotifyPrefs) => {
    const before = profileRef.current?.notifyPrefs ?? {};
    setProfile((p) => p ? { ...p, notifyPrefs: prefs } : p);
    const failed = (e: unknown) => { reportError(e, { op: "updateNotifyPrefs" }); toastError("Couldn't save notification preferences."); };
    const whole = () => store.updateNotifyPrefs(userIdRef.current, prefs);
    if (!store.configured) { whole().catch(failed); return; }
    const diff: NotifyPrefs = {};
    for (const k of new Set([...Object.keys(before), ...Object.keys(prefs)])) {
      if (JSON.stringify(before[k] ?? null) !== JSON.stringify(prefs[k] ?? null)) diff[k] = (prefs[k] ?? null) as NotifyPrefs[string];
    }
    if (!Object.keys(diff).length) return;
    import("./lib/notifyPrefs").then((m) => m.mergeNotifyPrefs(diff))
      .then((stored) => setProfile((p) => (p ? { ...p, notifyPrefs: stored } : p)), (e: unknown) => {
        const msg = String((e as { message?: unknown } | null)?.message ?? e);
        if ((e as { code?: string } | null)?.code === "PGRST202" || /could not find the function|merge_notify_prefs/i.test(msg)) return whole();
        throw e;
      })
      .catch(failed);
  }, [toastError]);
  /** NotificationPrefsPanel saved a change itself (merge_notify_prefs): the app's copy follows. */
  const notifyPrefsStored = useCallback((p: NotifyPrefs) => setProfile((x) => (x ? { ...x, notifyPrefs: p } : x)), []);

  /* ---- 0048: the guided first run and the gentle nudges (profiles.onboarding: tour, checklist, sample, momentum) ---- */
  // (the demo's own state, made once: a fresh one every render would look like a new profile each time)
  const [demoOnboarding] = useState<OnboardingState | undefined>(() => (store.configured ? undefined : demoOnboardingState()));
  const [onboarding, changeOnboarding, adoptOnboarding] = useOnboardingState(profile?.onboarding ?? demoOnboarding,
    { onError: () => toastInfo("Couldn't save your progress just now.") });
  const onboardingRef = useRef(onboarding); onboardingRef.current = onboarding;
  const tourWanted = useTourWanted();
  /** "Show my streak" / "Show my week's wins" / days off (onboarding.momentum). */
  const saveMomentum = useCallback((momentum: MomentumPrefs) => changeOnboarding({ ...onboardingRef.current, momentum }), [changeOnboarding]);

  // download all of the user's data as JSON (user-initiated, their own data)
  const exportData = useCallback(() => {
    const payload = {
      app: "Kanbo",
      exportedAt: new Date().toISOString(),
      profile,
      workspaces,
      members: wsMembers.map((m) => ({ workspaceId: m.workspaceId, userId: m.userId, name: getMember(m.userId ?? "")?.name || m.name, email: m.email, role: m.role, status: m.status })),
      projects,
      sections,
      customFields,
      tags,
      tasks: tasksRef.current ?? [],
      goals,
      portfolios,
      statusUpdates,
      automationRules,
      forms,
      savedSearches,
      activity,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `kanbo-export-${toLocalISO(new Date())}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toastSuccess("Your data is downloading");
  }, [profile, workspaces, wsMembers, projects, sections, customFields, tags, goals, portfolios, statusUpdates, automationRules, forms, savedSearches, activity, toastSuccess]);

  const deleteAccount = useCallback(async () => {
    await store.deleteAccount();
    // wipe local state and bounce to the signed-out site (a deleted account's
    // unsynced edits can never sync, so don't ask about them)
    if (auth.configured) await auth.signOut({ discardUnsynced: true });
  }, [auth]);

  /* ---- external calendars: several Google / Outlook accounts, chosen calendars in each ---- */
  // (demo mode: two example accounts from the store)
  const refreshCalendar = useCallback(async () => {
    setCalSyncing(true);
    try {
      const conns = await store.listCalendarConnections();
      setCalConnections(conns);
      if (conns.length) {
        const start = new Date(); start.setDate(1); start.setHours(0, 0, 0, 0);
        const end = new Date(start); end.setMonth(end.getMonth() + 2);
        const { events, warnings } = await store.loadExternalEvents(start.toISOString(), end.toISOString());
        setCalEvents(events);
        setCalWarnings(warnings);
      } else {
        setCalEvents([]);
        setCalWarnings([]);
      }
    } catch (e) { reportError(e); }
    finally { setCalSyncing(false); }
  }, []);
  // the demo's example accounts (a signed-in account loads its own below, on sign-in)
  useEffect(() => { if (!store.configured) void refreshCalendar(); }, [refreshCalendar]);

  const connectCalendar = useCallback(async (provider: CalProvider) => {
    try {
      // the provider sends the browser back here (?calendar=finish) and the app finishes the connection
      const url = await store.getCalendarAuthUrl(provider, { finishInApp: true });
      window.location.href = url; // full redirect to the provider's consent screen
    } catch (e) {
      reportError(e);
      toastError(e instanceof Error ? e.message : "Couldn't start the connection.");
    }
  }, [toastError]);

  /** Disconnect one account (by its id); its calendars leave Today and Month. */
  const disconnectCalendar = useCallback(async (connectionId: string) => {
    const who = calConnectionsRef.current.find((c) => c.id === connectionId)?.accountEmail;
    try { await store.disconnectCalendar(connectionId); toastSuccess(who ? `Disconnected ${who}` : "Calendar disconnected"); refreshCalendar(); }
    catch (e) { reportError(e); toastError("Couldn't disconnect that calendar."); }
  }, [toastSuccess, toastError, refreshCalendar]);
  /** Show these calendars from one account (Settings saves each tick straight away). */
  const selectCalendars = useCallback(async (connectionId: string, calendarIds: string[]) => {
    await store.selectCalendars(connectionId, calendarIds);
    void refreshCalendar();
  }, [refreshCalendar]);

  // first-run welcome — once, for a brand-new account (no tasks yet) OR any
  // account that still has no real name set (a name is needed so teammates and
  // assignment notifications show a person, not an email).
  const welcomeKey = `kanbo-welcomed-${currentUserId}`;
  useEffect(() => {
    if (!store.configured || tasks === null || currentUserId === "m-self") return;
    const self = getMember(currentUserId);
    const named = !!(self?.name && !self.name.includes("@"));
    if (tasks.length === 0 || !named) {
      try { if (!localStorage.getItem(welcomeKey)) setWelcomeOpen(true); } catch { /* private mode */ }
    }
  }, [tasks, welcomeKey, currentUserId]);
  const dismissWelcome = useCallback(() => {
    try { localStorage.setItem(welcomeKey, "1"); } catch { /* private mode */ }
    setWelcomeOpen(false);
  }, [welcomeKey]);

  // deep link: open ?task=<id> once tasks are loaded — in its own workspace. While
  // the panel is open the address keeps ?task= (so a refresh or a pasted link
  // reopens it); closing it takes it off again. Say so when the task can't be opened.
  const deepLinkDone = useRef(false);
  useEffect(() => {
    if (deepLinkDone.current || tasks === null) return;
    deepLinkDone.current = true;
    const tid = bootUrlRef.current?.task;
    if (!tid) return;
    const t = tasks.find((x) => x.id === tid);
    if (t) { setWorkspace(t.workspaceId ?? null); setDetailId(tid); }
    else toastInfo("That task doesn't exist any more, or you don't have access to it.");
  }, [tasks, toastInfo]);

  // the installed app's "New task" shortcut (/today?new=1): quick capture, once tasks are
  // loaded (openCapture keeps guests out, as the keyboard shortcut does)
  const newTaskShortcutDone = useRef(false);
  useEffect(() => {
    if (newTaskShortcutDone.current || tasks === null) return;
    newTaskShortcutDone.current = true;
    // (takes ?new off the address if it's still there; the boot read covers a rewritten one)
    const asked = takeNewTaskShortcut() || !!bootUrlRef.current?.newTask;
    if (asked) openCaptureRef.current();
  }, [tasks]);

  // a push notification clicked while Kanbo is open routes here, in place: a task opens
  // like the ?task= deep link, anything else (Today) is a route
  useEffect(() => listenForPushMessages((path) => {
    const u = new URL(path, window.location.origin);
    const tid = u.searchParams.get("task");
    if (!tid) { goRef.current(routeOf(u.pathname, u.search) ?? { view: "plan" }); return; }
    const t = (tasksRef.current ?? []).find((x) => x.id === tid);
    if (t) { setWorkspace(t.workspaceId ?? null); setDetailId(tid); }
    else toastInfoRef.current("That task doesn't exist any more, or you don't have access to it.");
  }), []);

  // load connected calendars on sign-in, and handle the OAuth round-trip return
  useEffect(() => {
    if (!store.configured || !authUserId) return;
    refreshCalendar();
    const params = new URLSearchParams(window.location.search);
    const cal = params.get("calendar");
    const state = params.get("calendar_state"), code = params.get("calendar_code");
    // clean the URL first, so a reload (or the back button) never replays the one-time code
    if (cal) {
      ["calendar", "calendar_state", "calendar_code", "fresh"].forEach((k) => params.delete(k));
      const qs = params.toString();
      window.history.replaceState({}, "", window.location.pathname + (qs ? "?" + qs : ""));
    }
    if (cal === "finish") {
      if (!state || !code) toastError("Couldn't connect that calendar. Please try again.");
      else store.finishCalendarConnect(state, code).then(({ provider, accountEmail, replaced }) => {
        const kind = provider === "microsoft" ? "Outlook" : "Google";
        toastSuccess(`${kind} calendar connected${accountEmail ? ` (${accountEmail})` : ""}`);
        // (a server before Kanbo's calendar update keeps one account of each kind)
        if (replaced) toastInfoRef.current(`It replaced your other ${kind} account. Several accounts of one kind arrive with Kanbo's next calendar update.`);
        setRoute({ view: "calendar" }, { replace: true });
        refreshCalendar();
      }, (e) => {
        reportError(e, { op: "finishCalendarConnect" });
        toastError(e instanceof Error && e.message ? e.message : "Couldn't connect that calendar. Please try again.");
      });
    }
    // the older hand-off, which the server still uses for legacy connections
    if (cal === "connected") { toastSuccess("Calendar connected"); setRoute({ view: "calendar" }, { replace: true }); }
    if (cal === "error") { toastError("Couldn't connect that calendar. Please try again."); setRoute({ view: "calendar" }, { replace: true }); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUserId]);

  /* ================= task writes =================
     Every task mutation is optimistic, then saved. If the save fails the change
     is rolled back on screen (only the fields that write still owns) and a toast
     offers Retry — nothing ever "looks saved" and silently reverts later. */

  /** A section chosen while it was still being created: wait for its real id. */
  const realSectionId = useCallback((id: string | undefined): Promise<string | undefined> => {
    if (!id || !id.startsWith("tmp-")) return Promise.resolve(id);
    const done = sectionAliasRef.current.get(id); if (done) return Promise.resolve(done);
    const p = tmpSectionRef.current.get(id);
    return p ? p.then((x) => x, () => undefined) : Promise.resolve(undefined);
  }, []);
  const withRealSections = useCallback(<T extends Partial<Task>>(row: T): Promise<T> => {
    const sec = row.sectionId, my = row.mySectionId;
    if (!sec?.startsWith("tmp-") && !my?.startsWith("tmp-")) return Promise.resolve(row);
    return Promise.all([realSectionId(sec), realSectionId(my)]).then(([s, m]) => ({
      ...row, ...("sectionId" in row ? { sectionId: s } : {}), ...("mySectionId" in row ? { mySectionId: m } : {}),
    }));
  }, [realSectionId]);

  /** Save one task patch — after the task's own insert if it is still being created.
   *  Resolves to the id that was written (null when it will be saved with a retried insert). */
  const writeTask = useCallback((id: string, patch: Partial<Task>): Promise<string | null> => {
    if (unsavedRef.current.has(id)) return Promise.resolve(null); // its insert failed: the row, edit included, is saved on Retry
    const creating = createsRef.current.get(id);
    const send = (sid: string) => withRealSections(patch).then((p) => store.updateTask(sid, p)).then(() => sid);
    if (creating) return creating.then(send, () => null);
    return send(id);
  }, [withRealSections]);

  const applyLocal = useCallback((patches: Map<string, Partial<Task>>) => {
    setTasks((ts) => ts && ts.map((t) => { const p = patches.get(t.id); return p ? { ...t, ...p } : t; }));
    patches.forEach((p, id) => noteWrite(id, p));
  }, [noteWrite]);

  const commitRef = useRef<(patches: Map<string, Partial<Task>>, prevById: Map<string, Task>, opts?: CommitOpts) => Promise<boolean>>(() => Promise.resolve(true));
  commitRef.current = (patches, prevById, opts = {}) => {
    const seq = ++writeSeqRef.current;
    patches.forEach((p, id) => Object.keys(p).forEach((k) => fieldSeqRef.current.set(`${id}:${k}`, seq)));
    const entries = [...patches];
    const written: (string | null)[] = [];
    return Promise.all(entries.map(([id, p], i) => writeTask(id, p).then((sid) => { written[i] = sid; return true; }, (e) => { reportError(e, { op: opts.op ?? "updateTask" }); return false; })))
      .then((oks) => {
        const me = userIdRef.current;
        // assignment emails go out once the new assignee is actually saved
        if (opts.notify !== false) entries.forEach(([id, p], i) => {
          const prev = prevById.get(id), sid = written[i];
          if (!oks[i] || !sid || !prev || !p.assigneeId || p.assigneeId === prev.assigneeId || p.assigneeId === me) return;
          store.notify({ kind: "assigned", taskId: sid, taskTitle: p.title ?? prev.title, recipientIds: [p.assigneeId] });
        });
        const failed = entries.filter((_, i) => !oks[i]);
        if (!failed.length) return true;
        // roll back only the fields this write still owns — a newer edit to the same field wins
        const restore = new Map<string, Partial<Task>>();
        for (const [id, p] of failed) {
          const prev = prevById.get(id); if (!prev) continue;
          const keys = Object.keys(p).filter((k) => fieldSeqRef.current.get(`${id}:${k}`) === seq);
          keys.forEach((k) => fieldSeqRef.current.delete(`${id}:${k}`));
          if (keys.length) { restore.set(id, pickFields(prev, keys)); clearWrite(id, keys); }
        }
        if (restore.size) setTasks((ts) => ts && ts.map((t) => { const r = restore.get(t.id); return r ? { ...t, ...r } : t; }));
        opts.onFailed?.(failed.map(([id]) => id));
        const again = new Map(failed);
        toastAction(opts.failMessage ? opts.failMessage(failed.length) : failed.length === 1 ? "Couldn't save — change undone" : `Couldn't save ${failed.length} changes — undone`, "Retry", () => {
          if (opts.retry) { opts.retry(); return; }
          const cur = tasksRef.current ?? [];
          const prev2 = new Map(cur.filter((t) => again.has(t.id)).map((t) => [t.id, t]));
          const still = new Map([...again].filter(([id]) => prev2.has(id)));
          if (!still.size) return;
          applyLocal(still);
          commitRef.current(still, prev2, opts);
        }, UNDO_MS);
        return false;
      });
  };
  const commit = useCallback((patches: Map<string, Partial<Task>>, prevById: Map<string, Task>, opts?: CommitOpts) => commitRef.current(patches, prevById, opts), []);

  /** Optimistically apply per-task patches, then save them (rolled back + Retry on failure). */
  const updateTasks = useCallback((patches: Map<string, Partial<Task>>, opts?: CommitOpts): Promise<boolean> => {
    if (!patches.size) return Promise.resolve(true);
    const cur = tasksRef.current ?? [];
    const prevById = new Map(cur.filter((t) => patches.has(t.id)).map((t) => [t.id, t]));
    applyLocal(patches);
    return commit(patches, prevById, opts);
  }, [applyLocal, commit]);

  /* ---- creating tasks ---- */
  const markUnsaved = useCallback((rows: Task[], e?: unknown) => {
    if (!rows.length) return;
    rows.forEach((r) => unsavedRef.current.add(r.id));
    setUnsavedIds([...unsavedRef.current]);
    const now = Date.now();
    if (now - lastUnsavedToastRef.current < 2000) return; // one toast per burst (an import can fail many rows at once)
    lastUnsavedToastRef.current = now;
    const why = (e as Error)?.message;
    toastAction(rows.length === 1 ? `Couldn't save “${rows[0].title}”${why ? ` — ${why}` : ""}` : `Couldn't save ${plural(rows.length, "task")}`, "Retry", () => retryUnsavedRef.current(), UNDO_MS);
  }, [toastAction]);

  /** A create resolved: keep the row through reloads for 30s more, and adopt a server-assigned id. */
  const settleCreate = useCallback((clientId: string, serverId: string) => {
    createsRef.current.delete(clientId);
    const until = Date.now() + 30000;
    pendingTasksRef.current = pendingTasksRef.current.map((p) => (p.id === clientId ? { ...p, until } : p));
    if (serverId !== clientId) remapTaskId(clientId, serverId);
  }, [remapTaskId]);

  const startCreate = useCallback((t: Task, opts: CreateOpts = {}): Promise<string | null> => {
    // a sub-task waits for its parent's insert (tasks.parent_id is a real foreign key)
    const parentWait = t.parentId ? createsRef.current.get(t.parentId) : undefined;
    cancelledRef.current.delete(t.id);
    const slot = opts.slot; // big batches (import, duplicate project) take turns — a few inserts at a time
    const run: Promise<string> = (parentWait ? parentWait.then((pid) => ({ ...t, parentId: pid })) : Promise.resolve(t))
      .then((row) => withRealSections(row))
      .then(async (row) => {
        if (slot) await slot.acquire();
        try {
          if (cancelledRef.current.has(t.id)) throw new Error("cancelled"); // deleted while waiting for its parent
          const saved = await store.createTask(row, userIdRef.current);
          // the insert doesn't carry completion/archive stamps: write them straight
          // after (and before any edit that was waiting for this insert), so a task
          // created straight into Done keeps its completion date after a reload
          const stamps: Partial<Task> = {};
          if (row.completedAt) stamps.completedAt = row.completedAt;
          if (row.archivedAt) stamps.archivedAt = row.archivedAt;
          if (Object.keys(stamps).length) await store.updateTask(saved.id, stamps).catch(saveFailed("createTask-stamps", `“${t.title}” was saved, but not when it was completed.`));
          return saved;
        } finally { slot?.release(); }
      })
      .then((saved) => {
        settleCreate(t.id, saved.id);
        if (opts.log !== false) log("created", { id: saved.id, title: t.title }, "Task created");
        // assignment email when a task is created for someone else (in-app is the DB trigger)
        if (opts.notify !== false && t.assigneeId && t.assigneeId !== userIdRef.current) {
          store.notify({ kind: "assigned", taskId: saved.id, taskTitle: t.title, recipientIds: [t.assigneeId] });
        }
        return saved.id;
      });
    createsRef.current.set(t.id, run);
    return run.catch((e) => {
      createsRef.current.delete(t.id);
      if (cancelledRef.current.has(t.id)) return null; // it was deleted meanwhile — nothing to save
      reportError(e, { op: "createTask" });
      markUnsaved([t], e);
      return null;
    });
  }, [withRealSections, settleCreate, log, markUnsaved, saveFailed]);

  /** Show a new task at once and save it. Resolves to its saved id (null if the save failed). */
  const persistTask = useCallback((raw: Task, opts: CreateOpts = {}): Promise<string | null> => {
    const me = userIdRef.current;
    // whoever creates the row is its creator (tasks.user_id), even for a copied
    // recurrence or duplicate, so it's under your Waiting on straight away
    const t: Task = stampCreator({
      ...raw,
      id: isTaskId(raw.id) ? raw.id : newTaskId(),
      assigneeId: raw.assigneeId === "m-self" ? me : raw.assigneeId,
      // a task lives in its project's workspace
      workspaceId: projectWs(raw.projectId),
      // new tasks sort to the bottom of their board column
      position: raw.position ?? Date.now(),
      // created straight into Done (a Done column, an import): it was completed today
      completedAt: raw.status === "done" ? raw.completedAt ?? toLocalISO(new Date()) : raw.completedAt,
    }, me);
    setTasks((ts) => (ts ? [t, ...ts] : [t]));
    // visible to callbacks straight away (the next render sets the same list), so a
    // follow-up in this same tick — e.g. taking back a just-spawned recurrence — finds it
    tasksRef.current = [t, ...(tasksRef.current ?? [])];
    pendingTasksRef.current = [{ id: t.id, task: t, until: null }, ...pendingTasksRef.current.filter((p) => p.id !== t.id)];
    return startCreate(t, opts);
  }, [startCreate]);

  const retryUnsaved = useCallback(() => {
    const ids = unsavedRef.current; if (!ids.size) return;
    const rows = (tasksRef.current ?? []).filter((t) => ids.has(t.id));
    ids.clear(); setUnsavedIds([]);
    // parents first, so each sub-task can wait for its parent
    for (const level of parentsFirst(rows)) for (const r of level) {
      pendingTasksRef.current = [{ id: r.id, task: r, until: null }, ...pendingTasksRef.current.filter((p) => p.id !== r.id)];
      startCreate(r, { log: false });
    }
  }, [startCreate]);
  retryUnsavedRef.current = retryUnsaved;

  const discardUnsaved = useCallback(() => {
    const ids = new Set(unsavedRef.current); if (!ids.size) return;
    if (!window.confirm(`Discard ${plural(ids.size, "unsaved task")}? ${ids.size === 1 ? "It never" : "They never"} reached the server, so ${ids.size === 1 ? "it's" : "they're"} gone for good.`)) return;
    unsavedRef.current.clear(); setUnsavedIds([]);
    setTasks((ts) => ts && ts.filter((t) => !ids.has(t.id)));
    dropPending(ids);
  }, [dropPending]);

  /** Copy a legacy checklist onto a task once it exists on the server (ticked items stay ticked). */
  const copyChecklist = useCallback((created: Promise<string | null>, items: Subtask[]) => {
    if (!items.length) return;
    created.then((sid) => {
      if (!sid) return;
      return Promise.all(items.map((s, i) => store.addSubtask(sid, s.title, i)
        .then((sub) => (s.done ? store.setSubtaskDone(sub.id, true).then(() => ({ ...sub, done: true })) : sub))))
        .then((subs) => setTasks((ts) => ts && ts.map((x) => (x.id === sid ? { ...x, subtasks: subs } : x))));
    }).catch(saveFailed("copyChecklist", "Couldn't copy the checklist."));
  }, [saveFailed]);

  /* ---- deleting tasks ---- */
  /** Delete rows on the server (roots only — the database cascades to sub-tasks). Resolves to the root ids that failed. */
  const serverDelete = useCallback((rows: Task[]): Promise<string[]> => {
    const ids = new Set(rows.map((r) => r.id));
    // anything still waiting to be inserted must not be inserted after all
    rows.forEach((r) => { if (createsRef.current.has(r.id)) cancelledRef.current.add(r.id); });
    // inserts that failed never reached the server — nothing to delete
    const live = rows.filter((r) => !unsavedRef.current.delete(r.id));
    if (live.length !== rows.length) setUnsavedIds([...unsavedRef.current]);
    const roots = live.filter((r) => !r.parentId || !ids.has(r.parentId));
    return runLimited(roots, 6, (r) => {
      const creating = createsRef.current.get(r.id);
      return creating ? creating.then((sid) => store.deleteTask(sid), () => undefined) : store.deleteTask(r.id);
    }).then((oks) => roots.filter((_, i) => !oks[i]).map((r) => r.id));
  }, []);

  /** Remove tasks (and all their sub-tasks) now, send the delete after the Undo window —
   *  or straight away if the page is closed (or, on a phone, put in the background),
   *  so it can't be lost. */
  const removeTasks = useCallback((roots: Task[], label: string) => {
    const all = tasksRef.current ?? [];
    const rootIds = new Set(roots.map((r) => r.id));
    const rows = [...roots, ...descendantsOf([...rootIds], all).filter((k) => !rootIds.has(k.id))];
    const ids = rows.map((r) => r.id), idSet = new Set(ids);
    const wasPending = new Set(pendingTasksRef.current.filter((p) => idSet.has(p.id)).map((p) => p.id));
    setTasks((ts) => ts && ts.filter((x) => !idSet.has(x.id)));
    // hidden from reloads for the whole Undo window, and a while after the delete goes out
    noteDelete(ids, UNDO_MS + WRITE_TTL); dropPending(idSet);
    const putBack = (subset: Task[]) => {
      clearWrite(subset.map((r) => r.id));
      setTasks((ts) => { const have = new Set((ts ?? []).map((x) => x.id)); const back = subset.filter((r) => !have.has(r.id)); return ts ? [...back, ...ts] : back; });
      const until = Date.now() + 30000;
      subset.forEach((r) => { if (wasPending.has(r.id)) pendingTasksRef.current = [{ id: r.id, task: r, until }, ...pendingTasksRef.current.filter((p) => p.id !== r.id)]; });
    };
    const key = ++delSeqRef.current;
    let state: "waiting" | "sent" | "undone" = "waiting";
    let sent: Promise<string[]> = Promise.resolve([]);
    const send = () => {
      if (state !== "waiting") return;
      state = "sent"; clearTimeout(timer); pendingDeletesRef.current.delete(key);
      noteDelete(ids);
      sent = serverDelete(rows);
      sent.then((failed) => {
        if (state === "undone") return;
        if (!failed.length) {
          log("deleted", { id: null, title: roots.length === 1 ? roots[0].title : plural(roots.length, "task") }, roots.length === 1 ? "Task deleted" : `Deleted ${plural(roots.length, "task")}`);
          return;
        }
        const f = new Set(failed);
        const failedTrees = new Set([...failed, ...descendantsOf(failed, rows).map((d) => d.id)]);
        putBack(rows.filter((r) => failedTrees.has(r.id)));
        const first = rows.find((r) => f.has(r.id));
        toastAction(failed.length === 1 ? `Couldn't delete “${first?.title ?? "that task"}” — it's been put back` : `Couldn't delete ${plural(failed.length, "task")} — they've been put back`, "Retry", () => {
          const again = (tasksRef.current ?? []).filter((t) => f.has(t.id));
          if (again.length) removeTasksRef.current(again, again.length === 1 ? `Deleted “${again[0].title}”` : `Deleted ${plural(again.length, "task")}`);
        }, UNDO_MS);
      });
    };
    const timer = setTimeout(send, UNDO_MS);
    pendingDeletesRef.current.set(key, send);
    toastAction(label, "Undo", () => {
      if (state === "undone") return;
      const alreadySent = state === "sent";
      state = "undone"; clearTimeout(timer); pendingDeletesRef.current.delete(key);
      putBack(rows);
      if (!alreadySent) return;
      // The delete already went out (the page was closed or backgrounded). Rows whose
      // delete failed are still on the server — they're simply back. The rest come back
      // from the recycle bin (0047) with their ids, comments, files and history; before
      // 0047 (or in demo mode) they're saved again as copies, with their checklist and
      // blocked-by links.
      sent.then(async (failed) => {
        const kept = new Set([...failed, ...descendantsOf(failed, rows).map((d) => d.id)]);
        const goneRows = rows.filter((r) => !kept.has(r.id));
        if (!goneRows.length) return;
        const goneRowIds = new Set(goneRows.map((r) => r.id));
        // the bin keeps one entry per deleted root (sub-tasks ride with their parent)
        const goneRoots = goneRows.filter((r) => !r.parentId || !goneRowIds.has(r.parentId));
        const sids = (await Promise.all(goneRoots.map((r) => (createsRef.current.get(r.id) ?? Promise.resolve(r.id)).catch(() => null))))
          .filter((x): x is string => !!x);
        const bin = await restoreDeletedItems(sids);
        if (bin.status !== "unavailable") {
          // putBack(rows) already put them on screen with their ids and comment counts
          clearWrite([...goneRowIds]);
          const back = new Set([...bin.restored, ...descendantsOf(bin.restored, goneRows).map((d) => d.id)]);
          const notBack = goneRows.filter((r) => !back.has(r.id));
          if (notBack.length) {
            const nb = new Set(notBack.map((r) => r.id));
            setTasks((ts) => ts && ts.filter((x) => !nb.has(x.id)));
            toastAction(notBack.length === 1 ? `Couldn't bring back “${notBack[0].title}”. It's in the recycle bin.` : `Couldn't bring back ${plural(notBack.length, "task")}. They're in the recycle bin.`,
              "Open recycle bin", () => setRoute({ view: "bin" }), UNDO_MS);
          }
          if (bin.notes.length) toastInfo(bin.notes.join(" "));
          return;
        }
        // before 0047, or demo: restore as copies
        const gone = goneRows.map((r) => ({ ...r, comments: 0 }));
        const goneIds = goneRowIds;
        setTasks((ts) => ts && ts.map((x) => (goneIds.has(x.id) ? { ...x, comments: 0 } : x))); // their comments didn't come back
        gone.forEach((r) => { pendingTasksRef.current = [{ id: r.id, task: r, until: null }, ...pendingTasksRef.current.filter((p) => p.id !== r.id)]; });
        const created = new Map<string, Promise<string | null>>();
        for (const level of parentsFirst(gone)) for (const r of level) {
          const p = startCreate(r, { log: false, notify: false });
          created.set(r.id, p);
          copyChecklist(p, r.subtasks);
        }
        // blocked-by links in both directions — the delete removed them on the server
        const onScreen = new Set((tasksRef.current ?? []).map((x) => x.id));
        const links: [string, string][] = [];
        gone.forEach((r) => (r.dependencies ?? []).forEach((d) => { if (onScreen.has(d) || goneIds.has(d)) links.push([r.id, d]); }));
        (tasksRef.current ?? []).forEach((x) => { if (!goneIds.has(x.id)) (x.dependencies ?? []).forEach((d) => { if (goneIds.has(d)) links.push([x.id, d]); }); });
        const sidOf = (id: string): Promise<string | null> => created.get(id) ?? createsRef.current.get(id) ?? Promise.resolve(id);
        runLimited(links, 4, ([a, b]) => Promise.all([sidOf(a), sidOf(b)]).then(([sa, sb]) => {
          if (!sa || !sb) throw new Error("restore: a task in the link wasn't saved");
          return store.addDependency(sa, sb);
        })).then((oks) => { const n = oks.filter((ok) => !ok).length; if (n) toastError(`${plural(n, "dependency link")} couldn't be restored.`); });
        toastInfo(gone.length === 1
          ? `Restored “${gone[0].title}” as a copy — it has a new link, and its comments, attachments and history couldn't be recovered.`
          : `Restored ${plural(gone.length, "task")} as copies — they have new links, and their comments, attachments and history couldn't be recovered.`);
      });
    }, UNDO_MS);
  }, [noteDelete, dropPending, clearWrite, serverDelete, log, toastAction, toastInfo, toastError, startCreate, copyChecklist, setRoute]);
  removeTasksRef.current = removeTasks;

  // A pending delete must not be lost when the page is closed, reloaded or frozen.
  // A phone may discard a backgrounded tab without warning, so there a hidden tab
  // sends at once. On a computer a background tab keeps running (its Undo timer
  // still fires), so a quick switch to another tab keeps Undo lossless.
  useEffect(() => {
    const flush = () => { [...pendingDeletesRef.current.values()].forEach((send) => send()); };
    let touch = false;
    try { touch = window.matchMedia("(hover: none) and (pointer: coarse)").matches; } catch { /* old browser: treat as a computer */ }
    const onVis = () => { if (touch && document.visibilityState === "hidden") flush(); };
    window.addEventListener("pagehide", flush);
    document.addEventListener("freeze", flush);
    document.addEventListener("visibilitychange", onVis);
    return () => { window.removeEventListener("pagehide", flush); document.removeEventListener("freeze", flush); document.removeEventListener("visibilitychange", onVis); };
  }, []);

  /* ---- status side effects (one path for checkbox, menu, board and bulk) ---- */
  // automation: apply enabled rules for the task's project (no hot-path mutation, no loops)
  const applyRules = useCallback((t: Task, trigger: AutomationRule["trigger"]): Task => {
    const rules = rulesRef.current.filter((r) => r.enabled && r.trigger === trigger && r.projectId === t.projectId);
    if (rules.length === 0) return t;
    let next = { ...t };
    for (const r of rules) for (const a of r.actions) {
      if (!a.value) continue;
      if (a.type === "set_priority") next = { ...next, priority: a.value as Task["priority"] };
      else if (a.type === "set_assignee") next = { ...next, assigneeId: a.value };
      else if (a.type === "set_section") next = { ...next, sectionId: a.value };
      else if (a.type === "add_tag") {
        // older rules stored the tag's name, not its id: resolve it when the rule runs
        const tagId = tagsRef.current[a.value] ? a.value : (resolveTagId(a.value, tagsRef.current) ?? a.value);
        next = { ...next, tags: [...new Set([...(next.tags ?? []), tagId])] };
      }
    }
    return next;
  }, []);
  const applyAutomation = useCallback((t: Task): Task => applyRules(t, "task_created"), [applyRules]);

  /** Spawn the next occurrence of a recurring task right away (so closing the tab
   *  can't lose it); Undo or reopening removes it again. */
  const spawnRecurrence = useCallback((t: Task) => {
    if (spawnedRef.current.has(t.id)) return;
    const rows = buildRecurrence(t, tasksRef.current ?? []);
    if (!rows) return;
    spawnedRef.current.set(t.id, rows[0].id);
    rows.forEach((r, i) => {
      const created = persistTask({ ...r, subtasks: [] }, { log: false, notify: false });
      if (i === 0) copyChecklist(created, t.subtasks.map((s) => ({ ...s, done: false })));
    });
  }, [persistTask, copyChecklist]);
  /** Take back the occurrence spawned when `id` was completed here. True when it was removed. */
  const unspawnRecurrence = useCallback((id: string): boolean => {
    const nextId = spawnedRef.current.get(id); if (!nextId) return false;
    spawnedRef.current.delete(id);
    const all = tasksRef.current ?? [];
    const next = all.find((x) => x.id === nextId);
    if (!next || next.status !== "todo" || next.comments > 0) return false; // someone already started on it — keep it
    const rows = [next, ...descendantsOf([nextId], all)];
    const ids = new Set(rows.map((r) => r.id));
    setTasks((ts) => ts && ts.filter((x) => !ids.has(x.id)));
    noteDelete([...ids]); dropPending(ids);
    serverDelete(rows).then((failed) => { if (failed.length) reportError(new Error("unspawn recurrence failed"), { op: "unspawnRecurrence" }); });
    return true;
  }, [noteDelete, dropPending, serverDelete]);

  /** Everything a real status change does, from every entry point: stamps or
   *  clears completedAt (only on a real transition), runs "status changed" and
   *  "task completed" automations, and spawns/unspawns recurrences. The activity
   *  row waits in `fx` until the save lands (see updateWithStatus).
   *  Returns the extra fields to save alongside the status. */
  const onStatusChange = useCallback((prev: Task, next: Task, fx: StatusFx): Partial<Task> => {
    const { completing, reopening, patch: extra } = statusTransition(prev, next.status);
    const base: Task = { ...next, ...extra };
    let auto = applyRules(base, "status_changed");
    if (completing) auto = applyRules(auto, "task_completed");
    if (auto.priority !== base.priority) extra.priority = auto.priority;
    if (auto.assigneeId !== base.assigneeId) extra.assigneeId = auto.assigneeId;
    if (auto.sectionId !== base.sectionId) extra.sectionId = auto.sectionId;
    if ((auto.tags ?? []).join() !== (base.tags ?? []).join()) extra.tags = auto.tags;
    if (completing) {
      fx.logs.set(prev.id, () => log("completed", prev, "Marked complete"));
      fx.completing.add(prev.id); spawnRecurrence(prev);
    } else if (reopening) {
      fx.logs.set(prev.id, () => log("reopened", prev, "Reopened"));
      if (unspawnRecurrence(prev.id)) fx.unspawned.set(prev.id, prev);
    } else fx.logs.set(prev.id, () => log("status", prev, `Moved to ${STATUS_META[next.status].label}`));
    return extra;
  }, [applyRules, log, spawnRecurrence, unspawnRecurrence]);

  /** Dependency enforcement: confirm before completing tasks that are still blocked. */
  const confirmCompleteBlocked = useCallback((rows: Task[]): boolean => {
    const byId = new Map((tasksRef.current ?? []).map((t) => [t.id, t]));
    const openBlockers = (t: Task) => (t.dependencies ?? []).filter((d) => { const b = byId.get(d); return !!b && b.status !== "done"; }).length;
    const blocked = rows.filter((t) => openBlockers(t) > 0);
    if (!blocked.length) return true;
    if (rows.length === 1) { const n = openBlockers(rows[0]); return window.confirm(`“${rows[0].title}” is blocked by ${plural(n, "unfinished task")}. Mark it complete anyway?`); }
    return window.confirm(`${plural(blocked.length, "task")} ${blocked.length === 1 ? "is" : "are"} blocked by unfinished tasks. Complete ${blocked.length === 1 ? "it" : "them"} anyway?`);
  }, []);

  /** Adjust a patch for where the task is going: the workspace follows the project,
   *  a section from the old project is cleared, and people who can't see the task
   *  there are dropped. Mutates `patch`; returns a note for the user, if any. */
  const retarget = useCallback((prev: Task, patch: Partial<Task>): string | null => {
    if (patch.projectId !== undefined && patch.projectId !== prev.projectId) {
      if (patch.workspaceId === undefined) patch.workspaceId = projectWs(patch.projectId);
      if (!("sectionId" in patch)) patch.sectionId = undefined;
    }
    if (!("workspaceId" in patch) || (patch.workspaceId ?? null) === (prev.workspaceId ?? null)) return null;
    const toWs = patch.workspaceId ?? null, me = userIdRef.current;
    const visible = new Set(toWs === null ? [] : wsMembersRef.current.filter((m) => (m.workspaceId ?? null) === toWs && m.status === "active" && m.userId).map((m) => m.userId as string));
    if (toWs !== null && visible.size === 0) return null; // member list unavailable — let the server decide
    visible.add(me);
    const collabs = patch.collaborators ?? prev.collaborators ?? [];
    if (collabs.some((x) => !visible.has(x))) patch.collaborators = collabs.filter((x) => visible.has(x));
    const followers = patch.followers ?? prev.followers ?? [];
    if (followers.some((x) => !visible.has(x))) patch.followers = followers.filter((x) => visible.has(x));
    const assignee = patch.assigneeId ?? prev.assigneeId;
    if (assignee && !visible.has(assignee)) {
      patch.assigneeId = me;
      const where = workspacesRef.current.find((w) => w.id === toWs)?.name || "Personal";
      return `${getMember(assignee)?.name || "The assignee"} isn't in ${where}, so “${prev.title}” is now assigned to you.`;
    }
    return null;
  }, []);

  /** Sub-tasks go wherever their parent goes (project, workspace) and are archived with it. */
  const cascadeToDescendants = useCallback((prev: Task, patch: Partial<Task>, all: Task[], into: Map<string, Partial<Task>>) => {
    const moved = ("projectId" in patch && patch.projectId !== prev.projectId) || ("workspaceId" in patch && (patch.workspaceId ?? null) !== (prev.workspaceId ?? null));
    const archiving = "archivedAt" in patch && patch.archivedAt !== prev.archivedAt;
    if (!moved && !archiving) return;
    for (const d of descendantsOf([prev.id], all)) {
      if (into.has(d.id)) continue;
      const dp: Partial<Task> = {};
      if (moved) {
        if ("projectId" in patch) dp.projectId = patch.projectId;
        if ("workspaceId" in patch) dp.workspaceId = patch.workspaceId;
        dp.sectionId = undefined;
        retarget(d, dp);
      }
      if (archiving && (patch.archivedAt ? !d.archivedAt : d.archivedAt === prev.archivedAt)) dp.archivedAt = patch.archivedAt;
      if (Object.keys(dp).length) into.set(d.id, dp);
    }
  }, [retarget]);

  /** Save patches that include status changes: the activity rows are logged once
   *  their save lands, and a save that fails takes its recurrence back (or puts
   *  back the occurrence a failed reopen removed) along with the rollback. */
  const updateWithStatus = useCallback((patches: Map<string, Partial<Task>>, fx: StatusFx, opts: CommitOpts = {}): Promise<boolean> => {
    const failed = new Set<string>();
    return updateTasks(patches, {
      ...opts,
      onFailed: (ids) => {
        ids.forEach((id) => {
          failed.add(id);
          if (fx.completing.has(id)) unspawnRecurrence(id);
          const reopened = fx.unspawned.get(id); if (reopened) spawnRecurrence(reopened);
        });
        opts.onFailed?.(ids);
      },
    }).then((ok) => { fx.logs.forEach((write, id) => { if (!failed.has(id)) write(); }); return ok; });
  }, [updateTasks, unspawnRecurrence, spawnRecurrence]);

  const toggleTask = useCallback((id: string) => {
    const t = tasksRef.current?.find((x) => x.id === id); if (!t) return;
    if (denyGuest([t.workspaceId])) return;
    const completing = t.status !== "done";
    if (completing && !confirmCompleteBlocked([t])) return;
    const status: Status = completing ? "done" : "todo";
    const fx = newStatusFx();
    const patch: Partial<Task> = { status, ...onStatusChange(t, { ...t, status }, fx) };
    updateWithStatus(new Map([[id, patch]]), fx, {
      // run the whole toggle again, side effects included (the failed one was rolled back)
      retry: () => { const cur = tasksRef.current?.find((x) => x.id === id); if (cur && cur.status === t.status) toggleTask(id); },
    });
    if (completing) {
      // its Undo always works (it puts the old fields back), so it can wait while you read
      toastAction(`Completed “${t.title}”`, "Undo", () => {
        unspawnRecurrence(id);
        updateTasks(new Map([[id, pickFields(t, Object.keys(patch))]]), { notify: false });
      }, {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [denyGuest, confirmCompleteBlocked, onStatusChange, updateWithStatus, updateTasks, unspawnRecurrence, toastAction]);

  const patchTaskRef = useRef<(id: string, patch: Partial<Task>) => void>(() => {});
  const bulkPatchRef = useRef<(ids: string[], patch: Partial<Task>, opts?: BulkOpts) => void>(() => {});
  const patchTask = useCallback((id: string, patchIn: Partial<Task>) => {
    const all = tasksRef.current ?? [];
    const prev = all.find((t) => t.id === id); if (!prev) return;
    const patch: Partial<Task> = { ...patchIn };
    // following a task is open to everyone who can see it (guests included)
    const onlyFollow = Object.keys(patch).length > 0 && Object.keys(patch).every((k) => k === "followers");
    if (!onlyFollow && denyGuest([prev.workspaceId])) return;
    // re-picking the same status must never restamp completedAt
    if ("status" in patch && (!patch.status || patch.status === prev.status)) { delete patch.status; delete patch.completedAt; }
    if (patch.status === "done" && !confirmCompleteBlocked([prev])) return;
    const note = retarget(prev, patch);
    if ("workspaceId" in patch && (patch.workspaceId ?? null) !== (prev.workspaceId ?? null) && denyGuest([patch.workspaceId])) return;
    Object.assign(patch, releasedPlan(prev, patch));
    const fx = newStatusFx();
    if (patch.status) Object.assign(patch, onStatusChange(prev, { ...prev, ...patch }, fx));
    if (!Object.keys(patch).length) return;
    const patches = new Map<string, Partial<Task>>([[id, patch]]);
    cascadeToDescendants(prev, patch, all, patches);
    // a failed status change is retried as a whole, so its side effects run again too
    if (fx.logs.size) updateWithStatus(patches, fx, { retry: () => patchTaskRef.current(id, patchIn) });
    else updateTasks(patches);
    if (note) toastInfo(note);
  }, [denyGuest, confirmCompleteBlocked, retarget, onStatusChange, cascadeToDescendants, updateWithStatus, updateTasks, toastInfo]);
  patchTaskRef.current = patchTask;

  // follow/unfollow a task (followers get its activity in their inbox)
  const followSeqRef = useRef(new Map<string, number>());
  const toggleFollow = useCallback((id: string) => {
    const t = tasksRef.current?.find((x) => x.id === id); if (!t) return;
    const uid = userIdRef.current;
    const mine = (f: string) => f.toLowerCase() === uid.toLowerCase();
    const follow = !(t.followers ?? []).some(mine); // what the person asked for; the server never toggles
    const apply = (list: string[], on: boolean) => (on ? (list.some(mine) ? list : [...list, uid]) : list.filter((f) => !mine(f)));
    const now = () => tasksRef.current?.find((x) => x.id === id)?.followers ?? [];
    const seq = (followSeqRef.current.get(id) ?? 0) + 1; followSeqRef.current.set(id, seq);
    const latest = () => followSeqRef.current.get(id) === seq; // a quicker second click wins
    applyLocal(new Map([[id, { followers: apply(t.followers ?? [], follow) }]]));
    store.setTaskFollow(id, follow).then((followers) => {
      if (!latest()) return;
      if (followers) { applyLocal(new Map([[id, { followers }]])); return; }
      // demo mode, offline or older edits to this task still queued, or 0042 not run yet:
      // a normal save, rolled back to the list before the click (with Retry) if it fails
      commit(new Map([[id, { followers: apply(now(), follow) }]]), new Map([[id, t]]));
    }, (e) => {
      reportError(e, { op: "setTaskFollow" });
      if (!latest()) return;
      applyLocal(new Map([[id, { followers: apply(now(), !follow) }]]));
      toastError(follow ? `Couldn't follow “${t.title}”` : `Couldn't unfollow “${t.title}”`);
    });
  }, [applyLocal, commit, toastError]);

  // toggle the signed-in user's emoji reaction on a task itself
  const toggleTaskReaction = useCallback((id: string, emoji: string) => {
    const t = tasksRef.current?.find((x) => x.id === id); if (!t) return;
    const uid = userIdRef.current;
    const r: Record<string, string[]> = { ...(t.reactions ?? {}) };
    const list = r[emoji] ?? [];
    r[emoji] = list.includes(uid) ? list.filter((x) => x !== uid) : [...list, uid];
    if (r[emoji].length === 0) delete r[emoji];
    patchTask(id, { reactions: r });
  }, [patchTask]);

  // add/remove a collaborator (extra assignee) on a task
  const toggleCollaborator = useCallback((id: string, memberId: string) => {
    const t = tasksRef.current?.find((x) => x.id === id); if (!t) return;
    const cur = t.collaborators ?? [];
    const next = cur.includes(memberId) ? cur.filter((c) => c !== memberId) : [...cur, memberId];
    patchTask(id, { collaborators: next });
  }, [patchTask]);

  // ---- bulk actions (multi-select) ----
  /** One change to many tasks, with one "Updated" toast whose Undo takes it all back.
   *  `patchFor` gives a task its own part of the change (the plan-state guard sends
   *  teammates' tasks only the shared fields); `undoAlso` joins that Undo. */
  const bulkPatch = useCallback((ids: string[], patchIn: Partial<Task>, opts: BulkOpts = {}) => {
    if (!ids.length) return;
    const all = tasksRef.current ?? [];
    const rows = ids.map((id) => all.find((t) => t.id === id)).filter((t): t is Task => !!t);
    if (!rows.length) return;
    if (denyGuest(rows.map((r) => r.workspaceId))) return;
    if (patchIn.projectId && denyGuest([projectWs(patchIn.projectId)])) return;
    if (patchIn.status === "done" && !confirmCompleteBlocked(rows.filter((r) => r.status !== "done"))) return;
    const patches = new Map<string, Partial<Task>>();
    const notes = new Set<string>();
    const completed: string[] = [];
    const fx = newStatusFx();
    for (const prev of rows) {
      const p: Partial<Task> = { ...(opts.patchFor ? opts.patchFor(prev) : patchIn) };
      // per task: completedAt only moves for tasks whose status really changes
      if ("status" in p && (!p.status || p.status === prev.status)) { delete p.status; delete p.completedAt; }
      const note = retarget(prev, p); if (note) notes.add(note);
      Object.assign(p, releasedPlan(prev, p));
      if (p.status) { if (p.status === "done") completed.push(prev.id); Object.assign(p, onStatusChange(prev, { ...prev, ...p }, fx)); }
      if (Object.keys(p).length) { patches.set(prev.id, p); cascadeToDescendants(prev, p, all, patches); }
    }
    if (!patches.size) {
      // only your own plan changed (teammates' tasks): that's still a change, with its Undo
      if (opts.undoAlso) toastAction(`Updated ${plural(rows.length, "task")} in your plan`, "Undo", opts.undoAlso, {});
      else toastInfo(`Nothing to change — ${rows.length === 1 ? "it's" : "they're"} already like that.`);
      return;
    }
    if (fx.logs.size) {
      // retry just the tasks whose save failed, as a fresh bulk change (side effects included)
      const failedIds: string[] = [];
      const picked = new Set(rows.map((r) => r.id));
      updateWithStatus(patches, fx, {
        onFailed: (fids) => failedIds.push(...fids.filter((x) => picked.has(x))),
        retry: () => { if (failedIds.length) bulkPatchRef.current(failedIds, patchIn, { patchFor: opts.patchFor }); },
      });
    } else updateTasks(patches);
    toastAction(`Updated ${plural(rows.length, "task")}`, "Undo", () => {
      completed.forEach(unspawnRecurrence);
      const present = new Set((tasksRef.current ?? []).map((t) => t.id));
      const back = new Map<string, Partial<Task>>();
      patches.forEach((p, id) => { const before = all.find((t) => t.id === id); if (before && present.has(id)) back.set(id, pickFields(before, Object.keys(p))); });
      updateTasks(back, { notify: false });
      opts.undoAlso?.();
    }, {});
    if (notes.size === 1) toastInfo([...notes][0]);
    else if (notes.size > 1) toastInfo(`${plural(notes.size, "task")} ${notes.size === 1 ? "was" : "were"} reassigned to you — their assignees aren't in that workspace.`);
  }, [denyGuest, confirmCompleteBlocked, retarget, onStatusChange, cascadeToDescendants, updateWithStatus, updateTasks, toastAction, toastInfo, unspawnRecurrence]);
  bulkPatchRef.current = bulkPatch;

  /* ---- personal plan state: the assignee-only write guard ----
     A task's plan fields (its slot, "on today", My-tasks section, Kanbo's order)
     belong to its assignee. Anyone else planning it keeps their own plan (lib/planOverlay:
     their task_user_state row once 0043 is live, so it follows them to every device;
     this device's storage before that and in demo) and only the task's own fields are saved. */
  const writeOverlay = useCallback((task: Task, personal: Partial<Pick<Task, PersonalKey>>) => {
    const me = userIdRef.current;
    const plan: { scheduled?: number | null; planToday?: boolean } = {};
    if ("scheduled" in personal) plan.scheduled = personal.scheduled ?? null;
    if ("planToday" in personal) plan.planToday = !!personal.planToday;
    if (Object.keys(plan).length) writePlanOverlay(me, todayISO(), task.id, plan);
    if ("mySectionId" in personal) writeSectionOverlay(me, task.id, personal.mySectionId);
    const score: { aiScore?: number; aiReason?: string } = {};
    if (typeof personal.aiScore === "number") score.aiScore = personal.aiScore;
    if (typeof personal.aiReason === "string") score.aiReason = personal.aiReason;
    if (Object.keys(score).length) writeScoreOverlay(me, task.id, score);
    setOverlayRev((n) => n + 1);
  }, []);

  /** patchTask behind the plan-state guard (every view's single-task edits go through
   *  it). Returns what the change replaced, on the row and in your own plan, so an
   *  Undo can put back exactly that (see undoGuarded). */
  const guardedWrite = useCallback((id: string, patch: Partial<Task>): GuardedUndo | null => {
    const t = tasksRef.current?.find((x) => x.id === id); if (!t) return null;
    // (the Undo also puts back a plan a change of assignee cleared)
    const rowKeys = (p: Partial<Task>) => [...Object.keys(p), ...Object.keys(releasedPlan(t, p))];
    if (ownerAfter(t, patch) === userIdRef.current) {
      patchTask(id, patch);
      return { id, row: pickFields(t, rowKeys(patch)), plan: null };
    }
    const { personal, shared } = splitPersonal(patch);
    let plan: GuardedUndo["plan"] = null;
    if (Object.keys(personal).length) {
      if (denyGuest([t.workspaceId])) return null;
      // what you saw there before: your own plan on it (the row's is its assignee's)
      const seen = seenRef.current?.find((x) => x.id === id) ?? t;
      plan = pickFields(seen, Object.keys(personal)) as GuardedUndo["plan"];
      writeOverlay(t, personal);
    }
    if (Object.keys(shared).length) patchTask(id, shared);
    return { id, row: pickFields(t, rowKeys(shared)), plan };
  }, [patchTask, denyGuest, writeOverlay]);
  const guardedPatch = useCallback((id: string, patch: Partial<Task>) => { guardedWrite(id, patch); }, [guardedWrite]);
  /** Put back what a guarded change replaced: the row's own fields that no longer
   *  hold their old value (a change that never landed writes nothing), and your plan. */
  const undoGuarded = useCallback((u: GuardedUndo) => {
    const now = tasksRef.current?.find((x) => x.id === u.id); if (!now) return;
    const row: Record<string, unknown> = {};
    const cur = now as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(u.row)) if (cur[k] !== v) row[k] = v;
    // handing a task back gives it back its whole plan, even the parts that match now
    // (left out, the change of assignee would clear them)
    if ("assigneeId" in row) for (const k of ["planToday", "scheduled", "mySectionId"]) if (k in u.row) row[k] = (u.row as Record<string, unknown>)[k];
    if (Object.keys(row).length) patchTask(u.id, row as Partial<Task>);
    if (u.plan) writeOverlay(now, u.plan);
  }, [patchTask, writeOverlay]);

  /** bulkPatch behind the same guard: one change, one "Updated" toast, one Undo
   *  (it puts back your plan on teammates' tasks too). */
  const guardedBulkPatch = useCallback((ids: string[], patch: Partial<Task>) => {
    const { personal, shared } = splitPersonal(patch);
    const all = tasksRef.current ?? [], me = userIdRef.current;
    const theirs = Object.keys(personal).length ? all.filter((t) => ids.includes(t.id) && ownerAfter(t, patch) !== me) : [];
    if (!theirs.length) { bulkPatch(ids, patch); return; }
    if (denyGuest(all.filter((t) => ids.includes(t.id)).map((t) => t.workspaceId))) return;
    const seen = new Map((seenRef.current ?? []).map((t) => [t.id, t]));
    const before = theirs.map((t) => ({ t, plan: pickFields(seen.get(t.id) ?? t, Object.keys(personal)) }));
    theirs.forEach((t) => writeOverlay(t, personal));
    const theirIds = new Set(theirs.map((t) => t.id));
    bulkPatch(ids, patch, {
      patchFor: (t) => (theirIds.has(t.id) ? shared : patch),
      undoAlso: () => before.forEach(({ t, plan }) => writeOverlay(t, plan)),
    });
  }, [bulkPatch, denyGuest, writeOverlay]);

  const deleteTask = useCallback((id: string) => {
    const all = tasksRef.current ?? [];
    const t = all.find((x) => x.id === id); if (!t) return;
    if (denyGuest([t.workspaceId])) return;
    // deleting a parent removes its sub-tasks too (the DB cascades); mirror that locally
    const kids = descendantsOf([id], all).length;
    removeTasks([t], kids ? `Deleted “${t.title}” and ${plural(kids, "sub-task")}` : `Deleted “${t.title}”`);
  }, [denyGuest, removeTasks]);

  const bulkDelete = useCallback((ids: string[]) => {
    if (!ids.length) return;
    const all = tasksRef.current ?? [];
    const sel = new Set(ids);
    const rows = all.filter((t) => sel.has(t.id));
    if (!rows.length) return;
    if (denyGuest(rows.map((r) => r.workspaceId))) return;
    const kids = descendantsOf(ids, all).filter((k) => !sel.has(k.id)).length;
    removeTasks(rows, `Deleted ${plural(rows.length, "task")}${kids ? ` and ${plural(kids, "sub-task")}` : ""}`);
  }, [denyGuest, removeTasks]);

  const archiveTask = useCallback((id: string) => {
    const all = tasksRef.current ?? [];
    const t = all.find((x) => x.id === id); if (!t) return;
    if (denyGuest([t.workspaceId])) return;
    const at = new Date().toISOString();
    const patches = new Map<string, Partial<Task>>([[id, { archivedAt: at }]]);
    cascadeToDescendants(t, { archivedAt: at }, all, patches);
    updateTasks(patches, { notify: false });
    const kids = patches.size - 1;
    toastAction(kids ? `Archived “${t.title}” and ${plural(kids, "sub-task")}` : `Archived “${t.title}”`, "Undo", () => {
      updateTasks(new Map([...patches.keys()].map((k) => [k, { archivedAt: undefined }])), { notify: false });
    }, {});
  }, [denyGuest, cascadeToDescendants, updateTasks, toastAction]);
  const unarchiveTask = useCallback((id: string) => {
    const all = tasksRef.current ?? [];
    const t = all.find((x) => x.id === id); if (!t) return;
    if (denyGuest([t.workspaceId])) return;
    // sub-tasks that were archived together with it come back with it
    const patches = new Map<string, Partial<Task>>([[id, { archivedAt: undefined }]]);
    cascadeToDescendants(t, { archivedAt: undefined }, all, patches);
    updateTasks(patches, { notify: false });
  }, [denyGuest, cascadeToDescendants, updateTasks]);

  // duplicate a task: a fresh to-do copy with its sub-tasks — no comments, reactions,
  // followers, time logged, schedule or plan carried over
  const duplicateTask = useCallback((id: string) => {
    const all = tasksRef.current ?? [];
    const src = all.find((t) => t.id === id); if (!src) return;
    if (denyGuest([src.workspaceId])) return;
    const rows = cloneTaskTree(src, all, (x, isRoot) => ({
      title: isRoot ? `${src.title} (copy)` : x.title,
      status: "todo", completedAt: undefined, archivedAt: undefined, comments: 0, dependencies: [], reactions: {}, followers: [],
      loggedHours: undefined, scheduled: null, planToday: false, createdAt: undefined, originalDueDate: undefined, subtasks: [],
      position: Date.now(),
    }));
    rows.forEach((r, i) => {
      const created = persistTask(r, { log: i === 0, notify: false });
      if (i === 0) copyChecklist(created, src.subtasks.map((s) => ({ ...s, done: false })));
    });
    toastSuccess(rows.length > 1 ? `Task duplicated with ${plural(rows.length - 1, "sub-task")}` : "Task duplicated");
  }, [denyGuest, persistTask, copyChecklist, toastSuccess]);

  /* ---- comments, checklists, sub-tasks, dependencies ---- */
  const addComment = useCallback(async (taskId: string, body: string, mentions: string[] = [], parentId?: string): Promise<Comment | null> => {
    const t = tasksRef.current?.find((x) => x.id === taskId);
    const authorName = getMember(userIdRef.current)?.name || "You";
    try {
      const c = await store.addComment(taskId, body, userIdRef.current, authorName, mentions, parentId);
      if (t) {
        const count = (tasksRef.current?.find((x) => x.id === taskId)?.comments ?? t.comments) + 1;
        setTasks((ts) => ts && ts.map((x) => x.id === taskId ? { ...x, comments: count } : x));
        noteWrite(taskId, { comments: count });
        // guests can comment but not write the task row — their count catches up on the next reload
        if (roleIn(t.workspaceId) !== "guest") writeTask(taskId, { comments: count }).catch(reportError);
        // no self-logged "comment" row: task_events keeps the history, and the
        // inbox only shows comments from other people (DB trigger)
        if (mentions.length) store.notify({ kind: "mention", taskId, taskTitle: t.title, recipientIds: mentions });
        store.notify({ kind: "comment", taskId, taskTitle: t.title });
      }
      return c;
    } catch (e) {
      reportError(e, { op: "addComment" });
      toastError("Couldn't post the comment.");
      return null;
    }
  }, [toastError, noteWrite, roleIn, writeTask]);

  const toggleSubtask = useCallback((taskId: string, subId: string) => {
    const task = tasksRef.current?.find((t) => t.id === taskId);
    const sub = task?.subtasks.find((s) => s.id === subId); if (!task || !sub) return;
    if (denyGuest([task.workspaceId])) return;
    const setDone = (done: boolean) => setTasks((ts) => ts && ts.map((t) => t.id === taskId ? { ...t, subtasks: t.subtasks.map((s) => s.id === subId ? { ...s, done } : s) } : t));
    const done = !sub.done;
    setDone(done);
    store.setSubtaskDone(subId, done).catch((e) => { reportError(e, { op: "setSubtaskDone" }); setDone(!done); toastError("Couldn't save — change undone"); });
  }, [denyGuest, toastError]);

  // a sub-task is a full task with parentId — it inherits the parent's project
  // (and therefore workspace) and assignee, and can be given its own due date,
  // priority, etc. just like any task.
  const addSubtask = useCallback((parentId: string, title: string) => {
    const parent = tasksRef.current?.find((t) => t.id === parentId);
    if (!parent) return;
    if (denyGuest([parent.workspaceId])) return;
    persistTask({
      id: newTaskId(),
      title, description: "", status: "todo", priority: "medium",
      projectId: parent.projectId, assigneeId: parent.assigneeId || userIdRef.current,
      parentId, tags: [], dependencies: [], subtasks: [], comments: 0,
      aiScore: 50, aiReason: undefined, focusMin: 30, dur: 30, scheduled: null,
      planToday: false, recurrence: "none", dueDate: undefined, position: Date.now(),
    });
  }, [denyGuest, persistTask]);

  /** Server ids for tasks that may still be being inserted. */
  const whenSaved = useCallback((ids: string[]): Promise<string[]> =>
    Promise.all(ids.map((id) => createsRef.current.get(id) ?? Promise.resolve(id))), []);

  // task dependencies (blocked-by)
  const setDeps = useCallback((taskId: string, deps: string[]) => {
    setTasks((ts) => ts && ts.map((t) => t.id === taskId ? { ...t, dependencies: deps } : t));
    noteWrite(taskId, { dependencies: deps });
  }, [noteWrite]);
  const addDependency = useCallback((taskId: string, dependsOn: string) => {
    if (taskId === dependsOn) return;
    const cur = tasksRef.current?.find((t) => t.id === taskId); if (!cur) return;
    if (denyGuest([cur.workspaceId])) return;
    const before = cur.dependencies ?? [];
    setDeps(taskId, [...new Set([...before, dependsOn])]);
    whenSaved([taskId, dependsOn]).then(([a, b]) => store.addDependency(a, b)).catch((e) => {
      reportError(e, { op: "addDependency" });
      const now = tasksRef.current?.find((t) => t.id === taskId)?.dependencies ?? [];
      setDeps(taskId, now.filter((d) => d !== dependsOn || before.includes(d)));
      toastError("Couldn't save — change undone");
    });
  }, [denyGuest, setDeps, whenSaved, toastError]);
  const removeDependency = useCallback((taskId: string, dependsOn: string) => {
    const cur = tasksRef.current?.find((t) => t.id === taskId); if (!cur) return;
    if (denyGuest([cur.workspaceId])) return;
    setDeps(taskId, (cur.dependencies ?? []).filter((d) => d !== dependsOn));
    whenSaved([taskId, dependsOn]).then(([a, b]) => store.removeDependency(a, b)).catch((e) => {
      reportError(e, { op: "removeDependency" });
      const now = tasksRef.current?.find((t) => t.id === taskId)?.dependencies ?? [];
      setDeps(taskId, [...new Set([...now, dependsOn])]);
      toastError("Couldn't save — change undone");
    });
  }, [denyGuest, setDeps, whenSaved, toastError]);

  /* ---- new tasks from every entry point ---- */
  /** Tell the user when a new task landed outside the workspace they're looking at. */
  const noteElsewhere = useCallback((projectIds: string[]) => {
    const ws = workspaceRef.current;
    const away = [...new Set(projectIds)].filter((pid) => projectWs(pid) !== ws);
    if (!away.length) return;
    const p = getProject(away[0]);
    const where = workspacesRef.current.find((w) => w.id === (p?.workspaceId ?? null))?.name || "Personal";
    const here = workspacesRef.current.find((w) => w.id === ws)?.name || "this workspace";
    const hasOpen = projectsRef.current.some((x) => (x.workspaceId ?? null) === ws && !x.archivedAt && !x.id.startsWith("tmp-"));
    toastInfo(`Added to “${p?.name ?? "Personal"}” in ${where}${hasOpen ? "." : ` — ${here} has no open projects yet.`}`);
  }, [toastInfo]);

  /** A full new task from a small partial (inline add, quick capture, import rows). */
  const buildNewTask = useCallback((partial: Partial<Task> & { title: string }): Task => {
    const r = routeRef.current, wsId = workspaceRef.current, me = userIdRef.current;
    const ps = projectsRef.current;
    const usable = (id?: string) => { const p = id ? ps.find((x) => x.id === id) : undefined; return p && !p.archivedAt && !p.id.startsWith("tmp-") ? p.id : undefined; };
    // the project you asked for, else the one you're looking at, else the first
    // open project in this workspace — never an archived one (it would vanish)
    const projectId = usable(partial.projectId)
      || (r.view === "project" ? usable(r.projectId) : undefined)
      || ps.find((p) => (p.workspaceId ?? null) === wsId && !p.archivedAt && !p.id.startsWith("tmp-"))?.id
      || "p-personal";
    const focusMin = partial.focusMin ?? 30;
    const assigneeId = partial.assigneeId || me;
    const base: Task = {
      id: newTaskId(),
      title: partial.title, description: partial.description ?? "", status: partial.status || "todo", priority: partial.priority || "medium",
      projectId, assigneeId, tags: partial.tags ?? [], dependencies: [], subtasks: [],
      comments: 0, aiScore: 50, aiReason: undefined, focusMin, dur: focusMin, scheduled: null,
      // only your own tasks go straight onto today's plan (a teammate's day is theirs to
      // plan): one added from Today, or captured with a time today ("call Sana 3pm")
      planToday: assigneeId === me && (partial.planToday ?? r.view === "plan"),
      // what capture and import read: "every mon", "~30m"
      recurrence: partial.recurrence ?? "none", ...(partial.effortHours ? { effortHours: partial.effortHours } : {}),
      dueDate: partial.dueDate, dueTime: partial.dueTime, startDate: partial.startDate,
      sectionId: partial.sectionId, mySectionId: partial.mySectionId, collaborators: partial.collaborators,
      position: partial.position ?? Date.now(),
    };
    return { ...base, energy: partial.energy ?? energyOf(base) };
  }, []);

  /** A task's plan is its assignee's: a new task that ends up with someone else
   *  (as asked, or by a rule) starts off their day, whatever the page it came from. */
  const unplanIfTheirs = useCallback((t: Task): Task => (
    (t.planToday || t.scheduled != null || t.mySectionId) && t.assigneeId && t.assigneeId !== userIdRef.current
      ? { ...t, planToday: false, scheduled: null, mySectionId: undefined } : t
  ), []);

  // inline quick-add + quick capture
  const quickAddTask = useCallback((partial: Partial<Task> & { title: string }) => {
    const t = unplanIfTheirs(applyAutomation(buildNewTask(partial)));
    if (denyGuest([projectWs(t.projectId)])) return;
    persistTask(t);
    noteElsewhere([t.projectId]);
  }, [applyAutomation, buildNewTask, denyGuest, persistTask, noteElsewhere, unplanIfTheirs]);

  // genuine "new task" entry points (modal, forms) run automation rules;
  // duplicate / recurrence / sub-tasks call persistTask directly (no rules)
  // (on Today a new task of yours lands on today's plan; one for a teammate, or one a
  // rule hands to someone else, never plans their day for them)
  const createTask = useCallback((t: Task) => {
    if (denyGuest([projectWs(t.projectId)])) return;
    persistTask(unplanIfTheirs(applyAutomation({ ...t, planToday: routeRef.current.view === "plan" ? (t.planToday ?? true) : false })));
  }, [denyGuest, persistTask, applyAutomation, unplanIfTheirs]);

  // Today's capture: in the workspace you're planning; yours unless you named someone
  // (@person); on today's plan unless it's for a later day. Like every new task, it never
  // plans a teammate's day, whoever it ends up with (you named them, or a rule did).
  const createFromPlan = useCallback((t: Task) => {
    const wsId = workspaceRef.current;
    let projectId = t.projectId;
    if (wsId !== null && projectWs(projectId) !== wsId) {
      projectId = projectsRef.current.find((p) => (p.workspaceId ?? null) === wsId && !p.archivedAt && !p.id.startsWith("tmp-"))?.id ?? projectId;
    }
    if (denyGuest([projectWs(projectId)])) return;
    persistTask(unplanIfTheirs(applyAutomation({
      ...t, id: newTaskId(), projectId, assigneeId: t.assigneeId || userIdRef.current, planToday: t.planToday ?? true,
    })));
    noteElsewhere([projectId]);
  }, [denyGuest, persistTask, applyAutomation, noteElsewhere, unplanIfTheirs]);

  /* ---- optimistic tmp-* rows (projects, sections, goals, rules…) ----
     Edits or deletes made before the create returns its real id are queued and
     replayed once it does, instead of failing against the tmp id. */
  const deferTmp = useCallback((id: string, patch?: object): boolean => {
    if (!id.startsWith("tmp-")) return false;
    const op = tmpOpsRef.current.get(id) ?? { patch: {}, deleted: false };
    if (patch) op.patch = { ...op.patch, ...patch }; else op.deleted = true;
    tmpOpsRef.current.set(id, op);
    return true;
  }, []);
  const settleTmp = useCallback(<P extends object>(tmpId: string, realId: string, update: (id: string, patch: P) => Promise<void>, remove: (id: string) => Promise<void>): { deleted: boolean; patch: Partial<P> } => {
    const op = tmpOpsRef.current.get(tmpId); tmpOpsRef.current.delete(tmpId);
    if (!op) return { deleted: false, patch: {} };
    if (op.deleted) { remove(realId).catch(saveFailed("settleTmp-delete")); return { deleted: true, patch: {} }; }
    if (Object.keys(op.patch).length) update(realId, op.patch as P).catch(saveFailed("settleTmp-update"));
    return { deleted: false, patch: op.patch as Partial<P> };
  }, [saveFailed]);

  /* ---- projects ---- */
  const createProject = useCallback((input: NewProject) => {
    if (denyGuest([input.workspaceId])) return;
    // optimistic: show it immediately, reconcile/rollback with the server
    const tmpId = "tmp-proj-" + Date.now();
    const { templateId, ...fields } = input;
    const optimistic: Project = { id: tmpId, ...fields };
    applyProjects([...projectsRef.current, optimistic]);
    store.createProject(input, userIdRef.current)
      .then((p) => {
        const op = settleTmp(tmpId, p.id, (id, patch: Parameters<typeof store.updateProject>[1]) => store.updateProject(id, patch), (id) => store.deleteProject(id));
        if (!op.deleted) noteCreated(p.id); // a reload already under way doesn't know about it yet
        applyProjects(op.deleted ? projectsRef.current.filter((x) => x.id !== tmpId) : swapTmp(projectsRef.current, tmpId, { ...p, ...op.patch }));
        setRouteRaw((r) => (r.view === "project" && r.projectId === tmpId ? { ...r, projectId: p.id } : r));
        // started from a built-in template: add its sections, then its starter tasks
        if (!op.deleted && templateId) {
          (async () => {
            const { findProjectTemplate, projectTemplateTasks } = await import("./lib/templates");
            const tpl = findProjectTemplate(templateId);
            if (!tpl?.tasks?.length) return;
            const sectionIds: Record<string, string> = {};
            for (const [i, name] of (tpl.sections ?? []).entries()) {
              const sec = await store.createSection({ projectId: p.id, workspaceId: p.workspaceId ?? null, name, position: Date.now() + i }, userIdRef.current);
              sectionIds[name] = sec.id;
              setSections((cur) => [...cur, sec]);
            }
            projectTemplateTasks(tpl, { projectId: p.id, workspaceId: p.workspaceId ?? null, assigneeId: userIdRef.current, sectionIds })
              .forEach((t) => persistTask(t, { log: false, notify: false }));
          })().catch((e) => { reportError(e, { op: "projectTemplate" }); toastError("Project created, but its starter tasks couldn't be added."); });
        }
      })
      .catch((e) => {
        reportError(e, { op: "createProject" });
        applyProjects(projectsRef.current.filter((x) => x.id !== tmpId));
        toastError("Couldn't save the project: " + (e?.message || e));
      });
  }, [denyGuest, applyProjects, settleTmp, noteCreated, toastError, persistTask]);

  /** `boardSettingsChange` (0048): just what changed on the board, for the database to merge (merge_board_settings);
   *  `boardSettings` is the whole object, for the app's own copy (and a database without that function). */
  const updateProject = useCallback((id: string, patch: { name?: string; emoji?: string; color?: string; description?: string; status?: string; ownerId?: string | null; contributorIds?: string[]; boardSettings?: BoardSettings; boardSettingsChange?: BoardSettingsChange }) => {
    const p = projectsRef.current.find((x) => x.id === id); if (!p) return;
    if (denyGuest([p.workspaceId])) return;
    const { boardSettingsChange, ...local } = patch;
    const before = Object.fromEntries(Object.keys(local).map((k) => [k, (p as unknown as Record<string, unknown>)[k]]));
    applyProjects(projectsRef.current.map((x) => x.id === id ? { ...x, ...local } : x));
    if (deferTmp(id, local)) return;
    store.updateProject(id, boardSettingsChange ? { ...local, boardSettingsChange } : local).catch((e) => {
      reportError(e, { op: "updateProject" });
      applyProjects(projectsRef.current.map((x) => x.id === id ? { ...x, ...before } : x));
      toastError("Couldn't save the project — change undone.");
    });
  }, [denyGuest, applyProjects, deferTmp, toastError]);

  const setProjectArchived = useCallback((id: string, archived: boolean) => {
    const p = projectsRef.current.find((x) => x.id === id); if (!p) return;
    if (denyGuest([p.workspaceId])) return;
    if (id.startsWith("tmp-")) { toastInfo("That project is still saving — try again in a moment."); return; }
    const prevAt = p.archivedAt ?? null;
    applyProjects(projectsRef.current.map((x) => x.id === id ? { ...x, archivedAt: archived ? new Date().toISOString() : null } : x));
    store.setProjectArchived(id, archived).catch((e) => {
      reportError(e, { op: "archiveProject" });
      applyProjects(projectsRef.current.map((x) => x.id === id ? { ...x, archivedAt: prevAt } : x));
      toastError("Couldn't update the project — change undone.");
    });
    if (archived) {
      // one click in the sidebar hides a team project for everyone: make it easy to take back
      toastAction(`Archived “${p.name}”`, "Undo", () => setProjectArchivedRef.current(id, false), {});
      if (routeRef.current.view === "project" && routeRef.current.projectId === id) setRoute({ view: "plan" }, { replace: true });
    }
    else toastSuccess(`Restored “${p.name}”`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [denyGuest, applyProjects, toastError, toastSuccess, toastInfo, toastAction]);
  const setProjectArchivedRef = useRef(setProjectArchived); setProjectArchivedRef.current = setProjectArchived;

  // duplicate a project as a template: clones sections + tasks (statuses reset to
  // to-do, completion/scheduling/time/reactions/followers cleared, sections,
  // parents and dependencies remapped). Parents are saved before their
  // sub-tasks, and dependency links only once both ends exist.
  const duplicateProject = useCallback(async (projectId: string) => {
    const src = projectsRef.current.find((p) => p.id === projectId);
    if (!src) return;
    const wsId = src.workspaceId ?? null;
    if (denyGuest([wsId])) return;
    if (projectId.startsWith("tmp-")) { toastInfo("That project is still saving — try again in a moment."); return; }
    const me = userIdRef.current;
    try {
      const np = await store.createProject({ name: `${src.name} (copy)`, emoji: src.emoji, color: src.color, workspaceId: wsId }, me);
      noteCreated(np.id); // a reload already under way doesn't know about it yet
      applyProjects([...projectsRef.current, np]);
      if (src.description || src.status || (src.contributorIds?.length ?? 0)) {
        store.updateProject(np.id, { description: src.description, status: src.status, contributorIds: src.contributorIds }).catch(reportError);
      }
      // clone sections, keeping an old→new id map
      const secMap = new Map<string, string>();
      for (const s of sectionsRef.current.filter((x) => x.projectId === projectId && !x.id.startsWith("tmp-")).sort((a, b) => (a.position ?? 0) - (b.position ?? 0))) {
        const ns = await store.createSection({ projectId: np.id, workspaceId: wsId, name: s.name, position: s.position }, me);
        secMap.set(s.id, ns.id); setSections((cur) => [...cur, ns]);
      }
      const all = tasksRef.current ?? [];
      const srcTasks = all.filter((t) => t.projectId === projectId && !t.archivedAt);
      const idMap = new Map(srcTasks.map((t) => [t.id, newTaskId()]));
      const base = Date.now();
      const clones: Task[] = srcTasks.map((t, i) => ({
        ...t, id: idMap.get(t.id)!, projectId: np.id, workspaceId: wsId,
        status: "todo", completedAt: undefined, archivedAt: undefined, scheduled: null, planToday: false,
        loggedHours: undefined, reactions: {}, followers: [], mySectionId: undefined, comments: 0, subtasks: [],
        createdAt: undefined, originalDueDate: undefined,
        sectionId: t.sectionId ? secMap.get(t.sectionId) : undefined,
        parentId: t.parentId ? idMap.get(t.parentId) : undefined,
        dependencies: (t.dependencies ?? []).map((d) => idMap.get(d)).filter((x): x is string => !!x),
        position: t.position ?? base + i,
      }));
      // show the copy straight away; it saves in the background
      setTasks((ts) => (ts ? [...clones, ...ts] : clones));
      pendingTasksRef.current = [...clones.map((t) => ({ id: t.id, task: t, until: null })), ...pendingTasksRef.current];
      setWorkspace(wsId); setRoute({ view: "project", projectId: np.id });
      toastSuccess(`Duplicated “${src.name}”`);
      // each task is saved on its own, a few at a time, parents first (a sub-task's
      // insert waits for its parent's). A row that fails is flagged with Retry on its
      // own; rows that saved are never sent again.
      const slot = createLimiter(6);
      const runs: [string, Promise<string | null>][] = [];
      for (const level of parentsFirst(clones)) for (const t of level) runs.push([t.id, startCreate(t, { log: false, notify: false, slot })]);
      const saved = new Map<string, string>(); // clone id → server id
      await Promise.all(runs.map(([cid, p]) => p.then((sid) => { if (sid) saved.set(cid, sid); })));
      const deps = clones.flatMap((c) => c.dependencies.map((d) => [c.id, d] as [string, string]));
      const ready = deps.filter(([a, b]) => saved.has(a) && saved.has(b));
      const depOk = await runLimited(ready, 4, ([a, b]) => store.addDependency(saved.get(a)!, saved.get(b)!));
      const lists = srcTasks.filter((t) => t.subtasks.length && saved.has(idMap.get(t.id)!));
      await runLimited(lists, 4, (t) => {
        const sid = saved.get(idMap.get(t.id)!)!;
        return Promise.all(t.subtasks.map((s, i) => store.addSubtask(sid, s.title, i)))
          .then((subs) => setTasks((ts) => ts && ts.map((x) => (x.id === sid ? { ...x, subtasks: subs } : x))));
      });
      // links that didn't make it (a failed link, or an end that didn't save) come off the
      // screen too, so the copy never shows a dependency the server doesn't have
      const lost = [...deps.filter(([a, b]) => !(saved.has(a) && saved.has(b))), ...ready.filter((_, i) => !depOk[i])];
      if (lost.length) {
        const cur = (id: string) => saved.get(id) ?? id; // ids may have moved to the server's
        const drop = new Map<string, Set<string>>();
        lost.forEach(([a, b]) => { const k = cur(a); const set = drop.get(k) ?? new Set<string>(); set.add(cur(b)); drop.set(k, set); });
        setTasks((ts) => ts && ts.map((x) => { const d = drop.get(x.id); return d ? { ...x, dependencies: (x.dependencies ?? []).filter((y) => !d.has(y)) } : x; }));
        toastError(`${plural(lost.length, "dependency link")} couldn't be copied.`);
      }
    } catch (e) { reportError(e, { op: "duplicateProject" }); toastError("Couldn't duplicate the project: " + ((e as Error)?.message || e)); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [denyGuest, applyProjects, startCreate, noteCreated, toastSuccess, toastError, toastInfo]);

  /** Mirrors the server rule (0041): a team project can be deleted by its creator/owner or a workspace owner/admin. */
  const canDeleteProject = useCallback((p: Project): boolean => {
    if ((p.workspaceId ?? null) === null) return true;
    const role = roleIn(p.workspaceId);
    if (role === "owner" || role === "admin") return true;
    if (role === "guest") return false;
    const me = userIdRef.current;
    if (p.ownerId === me || workspacesRef.current.find((w) => w.id === p.workspaceId)?.ownerId === me) return true;
    return !p.ownerId; // no owner recorded: the server knows the creator — let it decide
  }, [roleIn]);

  // Delete: the project is deleted FIRST; its tasks are only deleted once that succeeded.
  // Move: the tasks move FIRST; the project is only deleted once every one has left it,
  // so a move the server refuses never leaves tasks pointing at a deleted project.
  const confirmDeleteProject = useCallback(async (id: string, mode: DeleteMode, targetId?: string) => {
    setDeleteProjectId(null);
    if (id === "p-personal") return; // built-in default can't be deleted
    if (mode === "reassign" && !targetId) return; // never fall through to deleting
    const proj = projectsRef.current.find((p) => p.id === id); if (!proj) return;
    if (denyGuest([proj.workspaceId])) return;
    if (!canDeleteProject(proj)) { toastError(`Only the owner of “${proj.name}” or a workspace admin can delete it.`); return; }
    if (id.startsWith("tmp-")) { deferTmp(id); applyProjects(projectsRef.current.filter((p) => p.id !== id)); return; }
    const dropProject = () => {
      applyProjects(projectsRef.current.filter((p) => p.id !== id));
      setRouteRaw((r) => r.view === "project" && r.projectId === id ? { view: "tasks" } : r);
    };
    if (mode === "reassign" && targetId) {
      // tasks live in their project's workspace — carry the target's workspace so
      // moved tasks don't keep a stale one and vanish from view
      const targetWs = projectWs(targetId);
      const targetName = getProject(targetId)?.name ?? "another project";
      const moveThenDelete = async (): Promise<void> => {
        if (!projectsRef.current.some((p) => p.id === id)) return; // gone meanwhile
        const affected = (tasksRef.current || []).filter((t) => t.projectId === id);
        const patches = new Map(affected.map((t) => [t.id, { projectId: targetId, workspaceId: targetWs, sectionId: undefined } as Partial<Task>]));
        // a move that fails is undone on screen; its Retry toast runs the whole thing again
        const moved = await updateTasks(patches, {
          notify: false, op: "reassignOnProjectDelete", retry: () => { void moveThenDelete(); },
          failMessage: (n) => `Couldn't move ${plural(n, "task")} — “${proj.name}” was not deleted`,
        });
        if (!moved) return;
        try { await store.deleteProject(id); }
        catch (e) {
          reportError(e, { op: "deleteProject" });
          toastError(affected.length ? `Moved ${plural(affected.length, "task")} to “${targetName}”, but couldn't delete “${proj.name}”.` : `Couldn't delete “${proj.name}” — nothing was changed.`);
          return;
        }
        dropProject();
        toastSuccess(`Deleted “${proj.name}”${affected.length ? ` — ${plural(affected.length, "task")} moved to “${targetName}”` : ""}`);
      };
      await moveThenDelete();
      return;
    }
    try { await store.deleteProject(id); }
    catch (e) { reportError(e, { op: "deleteProject" }); toastError(`Couldn't delete “${proj.name}” — nothing was changed.`); return; }
    const affected = (tasksRef.current || []).filter((t) => t.projectId === id);
    dropProject();
    const ids = new Set(affected.map((t) => t.id));
    setTasks((ts) => ts && ts.filter((t) => !ids.has(t.id)));
    noteDelete([...ids]); dropPending(ids);
    const failed = await serverDelete(affected);
    if (failed.length) { toastError(`Deleted “${proj.name}”, but ${plural(failed.length, "task")} couldn't be deleted — refresh to see ${failed.length === 1 ? "it" : "them"}.`); return; }
    const deleted = `Deleted “${proj.name}”${affected.length ? ` and ${plural(affected.length, "task")}` : ""}`;
    // 0047: the project (with its tasks, sections and docs) waits in the recycle bin, so Undo
    // brings it all back. Demo mode has no bin (it would answer "unavailable"): no Undo there.
    if (!store.configured) { toastSuccess(deleted); return; }
    toastAction(`${deleted}. It's in the recycle bin for 30 days.`, "Undo", () => {
      void restoreDeletedItems([id]).then((r) => {
        if (r.status === "restored") {
          clearWrite([...ids]);
          applyProjects([...projectsRef.current.filter((p) => p.id !== id), proj]);
          setTasks((ts) => ts && [...affected.filter((a) => !ts.some((t) => t.id === a.id)), ...ts]);
          toastInfo(`Restored “${proj.name}”.`);
        } else if (r.status !== "unavailable") {
          toastAction(`Couldn't restore “${proj.name}”.`, "Open recycle bin", () => setRoute({ view: "bin" }));
        }
      });
    }, {});
  }, [denyGuest, canDeleteProject, deferTmp, applyProjects, updateTasks, noteDelete, dropPending, serverDelete, toastSuccess, toastError, toastAction, toastInfo, clearWrite, setRoute]);

  // ---- sections (ordered groupings within a project) ----
  const sectionWs = (s: Section | undefined) => (s ? s.workspaceId ?? projectWs(s.projectId) : null);
  /** Returns the new section's temporary id (tasks filed under it wait for the real one). */
  const createSection = useCallback((projectId: string, name: string, position?: number): string | undefined => {
    const wsId = projectWs(projectId);
    if (denyGuest([wsId])) return undefined;
    const pos = position ?? Date.now();
    const tmp: Section = { id: `tmp-sec-${pos}-${Math.round(Math.random() * 1e4)}`, projectId, workspaceId: wsId, name, position: pos };
    setSections((s) => [...s, tmp]);
    const saving = store.createSection({ projectId, workspaceId: wsId, name, position: pos }, userIdRef.current).then((sec) => {
      sectionAliasRef.current.set(tmp.id, sec.id);
      const op = settleTmp(tmp.id, sec.id, (id, patch: { name?: string; position?: number }) => store.updateSection(id, patch), (id) => store.deleteSection(id));
      setSections((s) => (op.deleted ? s.filter((x) => x.id !== tmp.id) : swapTmp(s, tmp.id, { ...sec, ...op.patch })));
      // tasks filed under it while it was saving move to the real id (their writes waited for it)
      const swap = (t: Partial<Task>) => ({ ...t, ...(t.sectionId === tmp.id ? { sectionId: sec.id } : {}), ...(t.mySectionId === tmp.id ? { mySectionId: sec.id } : {}) });
      setTasks((ts) => ts && ts.map((t) => (t.sectionId === tmp.id || t.mySectionId === tmp.id ? { ...t, ...swap(t) } : t)));
      recentWritesRef.current.forEach((w, id) => { if (w.patch.sectionId === tmp.id || w.patch.mySectionId === tmp.id) recentWritesRef.current.set(id, { ...w, patch: swap(w.patch) }); });
      return sec.id;
    });
    tmpSectionRef.current.set(tmp.id, saving);
    saving.catch((e) => {
      reportError(e, { op: "createSection" });
      setSections((s) => s.filter((x) => x.id !== tmp.id));
      toastError("Couldn't add the section: " + (e?.message || e));
    }).finally(() => tmpSectionRef.current.delete(tmp.id));
    return tmp.id;
  }, [denyGuest, settleTmp, toastError]);
  const renameSection = useCallback((id: string, name: string) => {
    const sec = sectionsRef.current.find((s) => s.id === id);
    if (denyGuest([sectionWs(sec)])) return;
    setSections((s) => s.map((x) => x.id === id ? { ...x, name } : x));
    if (deferTmp(id, { name })) return;
    store.updateSection(id, { name }).catch(saveFailed("renameSection", "Couldn't rename the section."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [denyGuest, deferTmp, saveFailed]);
  const deleteSection = useCallback((id: string) => {
    const sec = sectionsRef.current.find((s) => s.id === id);
    if (denyGuest([sectionWs(sec)])) return;
    setSections((s) => s.filter((x) => x.id !== id));
    const affected = (tasksRef.current ?? []).filter((t) => t.sectionId === id || t.mySectionId === id);
    updateTasks(new Map(affected.map((t) => [t.id, (t.sectionId === id ? { sectionId: undefined } : { mySectionId: undefined }) as Partial<Task>])), { notify: false });
    if (deferTmp(id)) return;
    store.deleteSection(id).catch(saveFailed("deleteSection", "Couldn't delete the section."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [denyGuest, updateTasks, deferTmp, saveFailed]);

  // CSV / paste import: positions in file order, one summary. Each row is saved on
  // its own (a few at a time), so one bad row only flags that row — the rest save,
  // and Retry never re-inserts a row that already made it. Rows nested under
  // another row become its sub-tasks; sections and tags the file names that
  // don't exist yet are created.
  const importTasks = useCallback((rows: ImportRow[], opts: { verb?: "Imported" | "Added" } = {}) => {
    if (!rows.length) return;
    const verb = opts.verb ?? "Imported";
    const me = userIdRef.current, base = Date.now();
    const today = toLocalISO(new Date());
    const built: Task[] = rows.map((r, i) => applyAutomation({ ...buildNewTask({ ...r, position: base + i }), planToday: false }))
      .map((t, i) => ({
        ...t, assigneeId: t.assigneeId === "m-self" ? me : t.assigneeId, workspaceId: projectWs(t.projectId),
        // the file's own date (Asana "Completed At", Jira "Resolved"), else it was done today
        completedAt: t.status === "done" ? rows[i].completedAt ?? today : undefined,
      }));
    // sub-tasks: under their parent row, in the parent's project (a parent may come later in the file)
    built.forEach((t, i) => { const pi = rows[i].parentIndex; if (pi !== undefined && pi !== i && built[pi]) t.parentId = built[pi].id; });
    const byId = new Map(built.map((t) => [t.id, t]));
    const moved = new Set<string>();
    for (const level of parentsFirst(built)) for (const t of level) {
      const parent = t.parentId ? byId.get(t.parentId) : undefined;
      if (!parent || parent.projectId === t.projectId) continue;
      Object.assign(t, { projectId: parent.projectId, workspaceId: parent.workspaceId, sectionId: undefined });
      moved.add(t.id);
    }
    if (denyGuest(built.map((t) => t.workspaceId))) return;
    // sections the file names that this project doesn't have yet (tasks wait for their real ids)
    const newSections = new Map<string, string | undefined>();
    built.forEach((t, i) => {
      const name = rows[i].sectionName?.trim();
      if (!name || t.sectionId || moved.has(t.id)) return;
      const key = `${t.projectId}\u0000${name.toLowerCase()}`;
      if (!newSections.has(key)) newSections.set(key, createSection(t.projectId, name, base + newSections.size));
      t.sectionId = newSections.get(key);
    });
    setTasks((ts) => (ts ? [...built, ...ts] : built));
    pendingTasksRef.current = [...built.map((t) => ({ id: t.id, task: t, until: null })), ...pendingTasksRef.current];
    const slot = createLimiter(6);
    // assignment emails for what was imported for other people (bounded — the in-app notification covers every task)
    let emails = 0;
    // parents first: a sub-task's insert waits for its parent's
    const runs = parentsFirst(built).flat().map((t) => startCreate(t, { log: false, notify: !!t.assigneeId && t.assigneeId !== me && emails++ < 20, slot }));
    // tags the file uses that don't exist yet: create them, then add them to their rows
    const fresh = new Map<string, string>();
    rows.forEach((r) => (r.newTags ?? []).forEach((l) => { const k = l.trim().toLowerCase(); if (k && !fresh.has(k)) fresh.set(k, l.trim()); }));
    if (fresh.size) {
      const wsId = workspaceRef.current;
      Promise.all([...fresh.values()].map((label, i) => store.createTag(label, TAG_COLORS[i % TAG_COLORS.length].c, me, wsId)
        .then((tag) => tag, (e) => { reportError(e, { op: "importTags" }); return null; })))
        .then((made) => {
          const ok = made.filter((x): x is NonNullable<typeof x> => !!x);
          if (ok.length) applyTags({ ...tagsRef.current, ...Object.fromEntries(ok.map((tag) => [tag.id, { label: tag.label, color: tag.color }])) });
          const idOf = new Map(ok.map((tag) => [tag.label.trim().toLowerCase(), tag.id]));
          const patches = new Map<string, Partial<Task>>();
          built.forEach((t, i) => {
            const add = (rows[i].newTags ?? []).map((l) => idOf.get(l.trim().toLowerCase())).filter((x): x is string => !!x);
            const cur = add.length ? tasksRef.current?.find((x) => x.id === t.id) : undefined;
            if (cur) patches.set(cur.id, { tags: [...new Set([...cur.tags, ...add])] });
          });
          if (patches.size) updateTasks(patches, { notify: false, op: "importTags" });
          const lost = made.length - ok.length;
          if (lost) toastError(`${plural(lost, "new tag")} couldn't be created, so ${lost === 1 ? "it was" : "they were"} left off.`);
        });
    }
    Promise.all(runs).then((ids) => {
      const saved = ids.filter((x): x is string => !!x);
      if (saved.length) log("created", { id: saved[0], title: `${verb} ${plural(saved.length, "task")}` }, `${verb} ${plural(saved.length, "task")}`);
    });
    const projs = [...new Set(built.map((t) => t.projectId))];
    toastSuccess(`${verb} ${plural(built.length, "task")}${projs.length === 1 ? ` ${verb === "Added" ? "to" : "into"} “${getProject(projs[0])?.name ?? "Personal"}”` : ""}`);
    noteElsewhere(projs);
  }, [applyAutomation, buildNewTask, denyGuest, startCreate, log, toastSuccess, toastError, noteElsewhere, createSection, applyTags, updateTasks]);

  // (saved searches are saved views since 0048: lib/views — the Sidebar's Views, Save view, ?view=)

  // ---- goals / OKRs ----
  type GoalPatch = Partial<Pick<Goal, "name" | "target" | "current" | "unit" | "due" | "status" | "parentId" | "projectId">>;
  const createGoal = useCallback((name: string) => {
    const wsId = workspaceRef.current;
    if (denyGuest([wsId])) return;
    const tmp: Goal = { id: "tmp-goal-" + Date.now(), workspaceId: wsId, name, status: "on_track", current: 0, target: 100 };
    setGoals((g) => [...g, tmp]);
    store.createGoal({ workspaceId: wsId, name, status: "on_track", current: 0, target: 100 }, userIdRef.current)
      .then((goal) => {
        const op = settleTmp(tmp.id, goal.id, (id, patch: GoalPatch) => store.updateGoal(id, patch), (id) => store.deleteGoal(id));
        setGoals((g) => (op.deleted ? g.filter((x) => x.id !== tmp.id) : swapTmp(g, tmp.id, { ...goal, ...op.patch })));
      })
      .catch((e) => { reportError(e, { op: "createGoal" }); setGoals((g) => g.filter((x) => x.id !== tmp.id)); toastError("Couldn't add the goal: " + (e?.message || e)); });
  }, [denyGuest, settleTmp, toastError]);
  const updateGoal = useCallback((id: string, patch: GoalPatch) => {
    if (denyGuest([workspaceRef.current])) return;
    setGoals((g) => g.map((x) => x.id === id ? { ...x, ...patch } : x));
    if (deferTmp(id, patch)) return;
    store.updateGoal(id, patch).catch(saveFailed("updateGoal"));
  }, [denyGuest, deferTmp, saveFailed]);
  const deleteGoal = useCallback((id: string) => {
    if (denyGuest([workspaceRef.current])) return;
    setGoals((g) => g.filter((x) => x.id !== id));
    if (deferTmp(id)) return;
    store.deleteGoal(id).catch(saveFailed("deleteGoal", "Couldn't delete the goal."));
  }, [denyGuest, deferTmp, saveFailed]);

  // ---- portfolios ----
  const createPortfolio = useCallback((name: string) => {
    const wsId = workspaceRef.current;
    if (denyGuest([wsId])) return;
    const tmp: Portfolio = { id: "tmp-pf-" + Date.now(), workspaceId: wsId, name, projectIds: [] };
    setPortfolios((p) => [...p, tmp]);
    store.createPortfolio({ workspaceId: wsId, name }, userIdRef.current)
      .then((pf) => {
        const op = settleTmp(tmp.id, pf.id, (id, patch: { name?: string; projectIds?: string[] }) => store.updatePortfolio(id, patch), (id) => store.deletePortfolio(id));
        setPortfolios((p) => (op.deleted ? p.filter((x) => x.id !== tmp.id) : swapTmp(p, tmp.id, { ...pf, ...op.patch })));
      })
      .catch((e) => { reportError(e, { op: "createPortfolio" }); setPortfolios((p) => p.filter((x) => x.id !== tmp.id)); toastError("Couldn't add the portfolio: " + (e?.message || e)); });
  }, [denyGuest, settleTmp, toastError]);
  const updatePortfolio = useCallback((id: string, patch: { name?: string; projectIds?: string[] }) => {
    if (denyGuest([workspaceRef.current])) return;
    setPortfolios((p) => p.map((x) => x.id === id ? { ...x, ...patch } : x));
    if (deferTmp(id, patch)) return;
    store.updatePortfolio(id, patch).catch(saveFailed("updatePortfolio"));
  }, [denyGuest, deferTmp, saveFailed]);
  const deletePortfolio = useCallback((id: string) => {
    if (denyGuest([workspaceRef.current])) return;
    setPortfolios((p) => p.filter((x) => x.id !== id));
    if (deferTmp(id)) return;
    store.deletePortfolio(id).catch(saveFailed("deletePortfolio", "Couldn't delete the portfolio."));
  }, [denyGuest, deferTmp, saveFailed]);

  // ---- project status updates ----
  const postStatusUpdate = useCallback((projectId: string, summary: string, status: StatusKind): Promise<boolean> => {
    const wsId = projectWs(projectId);
    if (denyGuest([wsId])) return Promise.resolve(false);
    return store.createStatusUpdate({ workspaceId: wsId, projectId, summary, status }, userIdRef.current)
      .then((su) => { setStatusUpdates((s) => [su, ...s]); return true; })
      .catch((e) => { reportError(e, { op: "statusUpdate" }); toastError("Couldn't post the update — your text is still there."); return false; });
  }, [denyGuest, toastError]);

  // ---- automation rules ----
  type RulePatch = { name?: string; actions?: AutomationAction[]; enabled?: boolean; trigger?: AutomationRule["trigger"] };
  const ruleWs = (id: string) => { const r = rulesRef.current.find((x) => x.id === id); return r ? r.workspaceId ?? projectWs(r.projectId) : workspaceRef.current; };
  const createRule = useCallback((projectId: string, name: string, actions: AutomationAction[], trigger: AutomationRule["trigger"] = "task_created") => {
    const wsId = projectWs(projectId);
    if (denyGuest([wsId])) return;
    const tmp: AutomationRule = { id: "tmp-rule-" + Date.now(), workspaceId: wsId, projectId, name, trigger, actions, enabled: true };
    setAutomationRules((rs) => [...rs, tmp]);
    store.createRule({ workspaceId: wsId, projectId, name, actions, trigger }, userIdRef.current)
      .then((rule) => {
        const op = settleTmp(tmp.id, rule.id, (id, patch: RulePatch) => store.updateRule(id, patch), (id) => store.deleteRule(id));
        setAutomationRules((rs) => (op.deleted ? rs.filter((x) => x.id !== tmp.id) : swapTmp(rs, tmp.id, { ...rule, ...op.patch })));
      })
      .catch((e) => { reportError(e, { op: "createRule" }); setAutomationRules((rs) => rs.filter((x) => x.id !== tmp.id)); toastError("Couldn't add the rule: " + (e?.message || e)); });
  }, [denyGuest, settleTmp, toastError]);
  const updateRule = useCallback((id: string, patch: RulePatch) => {
    if (denyGuest([ruleWs(id)])) return;
    setAutomationRules((rs) => rs.map((x) => x.id === id ? { ...x, ...patch } : x));
    if (deferTmp(id, patch)) return;
    store.updateRule(id, patch).catch(saveFailed("updateRule"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [denyGuest, deferTmp, saveFailed]);
  const deleteRule = useCallback((id: string) => {
    if (denyGuest([ruleWs(id)])) return;
    setAutomationRules((rs) => rs.filter((x) => x.id !== id));
    if (deferTmp(id)) return;
    store.deleteRule(id).catch(saveFailed("deleteRule", "Couldn't delete the rule."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [denyGuest, deferTmp, saveFailed]);

  // ---- intake forms ----
  const formsRef = useRef<FormDef[]>([]); formsRef.current = forms;
  const formWs = (id: string) => { const f = formsRef.current.find((x) => x.id === id); return f ? f.workspaceId ?? projectWs(f.projectId) : workspaceRef.current; };
  const createForm = useCallback((projectId: string, name: string, fields: FormFieldKey[]) => {
    const wsId = projectWs(projectId);
    if (denyGuest([wsId])) return;
    const tmp: FormDef = { id: "tmp-form-" + Date.now(), workspaceId: wsId, projectId, name, fields };
    setForms((fs) => [...fs, tmp]);
    store.createForm({ workspaceId: wsId, projectId, name, fields }, userIdRef.current)
      .then((form) => {
        const op = settleTmp(tmp.id, form.id, (id, patch: { name?: string; fields?: FormFieldKey[] }) => store.updateForm(id, patch), (id) => store.deleteForm(id));
        setForms((fs) => (op.deleted ? fs.filter((x) => x.id !== tmp.id) : swapTmp(fs, tmp.id, { ...form, ...op.patch })));
      })
      .catch((e) => { reportError(e, { op: "createForm" }); setForms((fs) => fs.filter((x) => x.id !== tmp.id)); toastError("Couldn't add the form: " + (e?.message || e)); });
  }, [denyGuest, settleTmp, toastError]);
  const updateForm = useCallback((id: string, patch: { name?: string; fields?: FormFieldKey[] }) => {
    if (denyGuest([formWs(id)])) return;
    setForms((fs) => fs.map((x) => x.id === id ? { ...x, ...patch } : x));
    if (deferTmp(id, patch)) return;
    store.updateForm(id, patch).catch(saveFailed("updateForm"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [denyGuest, deferTmp, saveFailed]);
  const deleteForm = useCallback((id: string) => {
    if (denyGuest([formWs(id)])) return;
    setForms((fs) => fs.filter((x) => x.id !== id));
    if (deferTmp(id)) return;
    store.deleteForm(id).catch(saveFailed("deleteForm", "Couldn't delete the form."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [denyGuest, deferTmp, saveFailed]);
  // a form submission becomes a task (and runs the project's automation rules).
  // It goes to the project's owner by default — never silently to the submitter.
  // A form that asks for an assignee sends "" for its explicit "Unassigned".
  const submitForm = useCallback((projectId: string, vals: FormValues) => {
    const proj = getProject(projectId);
    if (denyGuest([proj?.workspaceId ?? null])) return;
    createTask({
      id: newTaskId(),
      title: vals.title, description: vals.description ?? "", status: "todo", priority: (vals.priority as Task["priority"]) || "medium",
      projectId, assigneeId: vals.assigneeId ?? (proj?.ownerId || userIdRef.current), tags: [], dependencies: [], subtasks: [],
      comments: 0, aiScore: 50, aiReason: undefined, focusMin: 30, dur: 30, scheduled: null, planToday: false,
      recurrence: "none", dueDate: vals.dueDate || undefined, position: Date.now(),
    });
    toastSuccess("Submitted — task created");
  }, [denyGuest, createTask, toastSuccess]);

  // ---- custom fields (per-project definitions) ----
  const createCustomField = useCallback((projectId: string, name: string, type: CustomFieldDef["type"], options: string[] = []) => {
    const wsId = projectWs(projectId);
    if (denyGuest([wsId])) return;
    const tmp: CustomFieldDef = { id: "tmp-cf-" + Date.now(), projectId, workspaceId: wsId, name, type, options };
    setCustomFields((cs) => [...cs, tmp]);
    store.createCustomField({ projectId, workspaceId: wsId, name, type, options }, userIdRef.current)
      .then((def) => {
        const op = settleTmp(tmp.id, def.id, (id, patch: { name?: string; options?: string[]; position?: number }) => store.updateCustomField(id, patch), (id) => store.deleteCustomField(id));
        setCustomFields((cs) => (op.deleted ? cs.filter((c) => c.id !== tmp.id) : swapTmp(cs, tmp.id, { ...def, ...op.patch })));
      })
      .catch((e) => { reportError(e, { op: "createCustomField" }); setCustomFields((cs) => cs.filter((c) => c.id !== tmp.id)); toastError("Couldn't add the field: " + (e?.message || e)); });
  }, [denyGuest, settleTmp, toastError]);
  const customFieldsRef = useRef<CustomFieldDef[]>([]); customFieldsRef.current = customFields;
  const deleteCustomField = useCallback((id: string) => {
    const f = customFieldsRef.current.find((c) => c.id === id);
    if (denyGuest([f ? f.workspaceId ?? projectWs(f.projectId) : workspaceRef.current])) return;
    setCustomFields((cs) => cs.filter((c) => c.id !== id));
    if (deferTmp(id)) return;
    store.deleteCustomField(id).catch(saveFailed("deleteCustomField", "Couldn't delete the field."));
  }, [denyGuest, deferTmp, saveFailed]);

  /* ---- tags ---- */
  const createTag = useCallback((label: string, color: string) => {
    if (denyGuest([workspaceRef.current])) return;
    const tmpId = "tmp-tag-" + Date.now();
    applyTags({ ...tagsRef.current, [tmpId]: { label, color } });
    store.createTag(label, color, userIdRef.current, workspaceRef.current)
      .then((tag) => {
        const op = settleTmp(tmpId, tag.id, (id, patch: { label?: string; color?: string }) => store.updateTag(id, patch), (id) => store.deleteTag(id));
        const next = { ...tagsRef.current };
        delete next[tmpId];
        if (!op.deleted) next[tag.id] = { label: tag.label, color: tag.color, ...op.patch };
        applyTags(next);
        // tasks tagged while it was saving get the real id
        const tagged = (tasksRef.current ?? []).filter((t) => t.tags.includes(tmpId));
        if (tagged.length) updateTasks(new Map(tagged.map((t) => [t.id, { tags: op.deleted ? t.tags.filter((x) => x !== tmpId) : t.tags.map((x) => (x === tmpId ? tag.id : x)) }])), { notify: false });
      })
      .catch((e) => {
        reportError(e, { op: "createTag" });
        const next = { ...tagsRef.current }; delete next[tmpId]; applyTags(next);
        toastError("Couldn't save the tag: " + (e?.message || e));
      });
  }, [denyGuest, applyTags, settleTmp, updateTasks, toastError]);

  // tag edits touch tasks everywhere — only those you can edit are rewritten
  const editableTasks = useCallback((pred: (t: Task) => boolean) => (tasksRef.current ?? []).filter((t) => pred(t) && roleIn(t.workspaceId) !== "guest"), [roleIn]);

  const deleteTag = useCallback((id: string) => {
    if (denyGuest([workspaceRef.current])) return;
    // drop it from any tasks that use it, then remove the tag
    const affected = editableTasks((t) => t.tags.includes(id));
    if (affected.length) updateTasks(new Map(affected.map((t) => [t.id, { tags: t.tags.filter((x) => x !== id) }])), { notify: false });
    const next = { ...tagsRef.current }; delete next[id]; applyTags(next);
    if (deferTmp(id)) return;
    store.deleteTag(id).catch(saveFailed("deleteTag", "Couldn't delete the tag."));
  }, [denyGuest, editableTasks, updateTasks, applyTags, deferTmp, saveFailed]);

  const updateTag = useCallback((id: string, patch: { label?: string; color?: string }) => {
    const cur = tagsRef.current[id]; if (!cur) return;
    if (denyGuest([workspaceRef.current])) return;
    applyTags({ ...tagsRef.current, [id]: { ...cur, ...patch } });
    if (deferTmp(id, patch)) return;
    store.updateTag(id, patch).catch((e) => { reportError(e, { op: "updateTag" }); applyTags({ ...tagsRef.current, [id]: cur }); toastError("Couldn't update the tag — change undone."); });
  }, [denyGuest, applyTags, deferTmp, toastError]);

  // merge tag `fromId` into `intoId`: re-tag every task, then drop fromId
  const mergeTags = useCallback((fromId: string, intoId: string) => {
    if (fromId === intoId) return;
    if (denyGuest([workspaceRef.current])) return;
    const affected = editableTasks((t) => t.tags.includes(fromId));
    if (affected.length) updateTasks(new Map(affected.map((t) => [t.id, { tags: [...new Set(t.tags.map((x) => (x === fromId ? intoId : x)))] }])), { notify: false });
    const next = { ...tagsRef.current }; delete next[fromId]; applyTags(next);
    if (!deferTmp(fromId)) store.deleteTag(fromId).catch(saveFailed("mergeTags", "Couldn't finish merging the tags."));
    toastSuccess("Tags merged");
  }, [denyGuest, editableTasks, updateTasks, applyTags, deferTmp, saveFailed, toastSuccess]);

  /* ---- team templates ---- */
  /** Set up a team template's projects (sections, starter tasks assigned to you, a request
   *  form and a rule each) in a workspace, through the same creates as everything else.
   *  Says how it went in one toast, and resolves with what was created (null if it failed). */
  const applyTeamTemplate = useCallback(async (template: WorkspaceTemplate, projectKeys: string[] | undefined, workspaceId: string | null) => {
    const me = userIdRef.current;
    let tpl: typeof import("./lib/templates");
    try { tpl = await import("./lib/templates"); } catch (e) {
      reportError(e, { op: "applyTeamTemplate" });
      toastError(`Couldn't set up ${template.name}. Check your connection and try again.`);
      return null;
    }
    const { buildWorkspaceFromTemplate, applyWorkspacePlan, appliedPlanMessage } = tpl;
    const plan = buildWorkspaceFromTemplate(template, toLocalISO(KANBO_TODAY), { projectKeys });
    let r: Awaited<ReturnType<typeof applyWorkspacePlan>>;
    try {
      r = await applyWorkspacePlan(plan, { workspaceId, assigneeId: me }, store.templateDeps(me));
    } catch (e) {
      reportError(e, { op: "applyTeamTemplate" });
      toastError(`Couldn't set up ${plan.name}. Check your connection and try again.`);
      return null;
    }
    // a reload already under way doesn't know about any of this yet: keep the projects,
    // and hold the starter tasks for a while (as for any task created here)
    r.projects.forEach((p) => noteCreated(p.id));
    const until = Date.now() + 30000;
    const made = new Set(r.tasks.map((t) => t.id));
    pendingTasksRef.current = [...r.tasks.map((t) => ({ id: t.id, task: t, until })), ...pendingTasksRef.current.filter((p) => !made.has(p.id))];
    applyProjects([...projectsRef.current.filter((x) => !r.projects.some((p) => p.id === x.id)), ...r.projects]);
    setSections((cur) => [...cur.filter((x) => !r.sections.some((y) => y.id === x.id)), ...r.sections]);
    setTasks((ts) => ts && [...r.tasks.filter((t) => !ts.some((x) => x.id === t.id)), ...ts]);
    setForms((cur) => [...cur.filter((x) => !r.forms.some((y) => y.id === x.id)), ...r.forms]);
    setAutomationRules((cur) => [...cur.filter((x) => !r.rules.some((y) => y.id === x.id)), ...r.rules]);
    // sections, forms and rules aren't held through an older snapshot: ask for a fresh one
    requestReloadRef.current?.();
    const m = appliedPlanMessage(plan, r);
    (m.tone === "success" ? toastSuccess : m.tone === "error" ? toastError : toastInfo)(m.text);
    return r;
  }, [noteCreated, applyProjects, toastSuccess, toastError, toastInfo]);

  /** Projects › New project › "From a team template": the template's projects in the
   *  current workspace (never for guests), then the first one opens. */
  const createFromTeamTemplate = useCallback(async (template: WorkspaceTemplate, projectKeys?: string[]) => {
    const wsId = workspaceRef.current;
    if (denyGuest([wsId])) return;
    const r = await applyTeamTemplate(template, projectKeys, wsId);
    if (r?.projects.length && workspaceRef.current === wsId) setRoute({ view: "project", projectId: r.projects[0].id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [denyGuest, applyTeamTemplate]);

  /* ---- 0047: plan a project with Kanbo (the AI planner; on-device when AI is off) ---- */
  /** New mode plans a project in the workspace you're in; append adds tasks to `projectId`. Never for guests. */
  const openPlanner = useCallback((p: { mode: "new" | "append"; projectId?: string; goal?: string }) => {
    const wsId = p.mode === "append" && p.projectId ? projectWs(p.projectId) : workspaceRef.current;
    if (denyGuest([wsId])) return;
    setPlanner(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [denyGuest]);
  /** What the planner made (it never calls this after a full rollback): keep it through any
   *  reload already under way, show it, say how it went, and open the project. */
  const onPlanCreated = useCallback((r: AppliedProjectPlan, message: { tone: "success" | "info" | "error"; text: string }) => {
    if (r.project && !projectsRef.current.some((x) => x.id === r.project!.id)) {
      noteCreated(r.project.id);
      applyProjects([...projectsRef.current.filter((x) => x.id !== r.project!.id), r.project]);
    }
    const until = Date.now() + 30000;
    pendingTasksRef.current = [...r.tasks.map((t) => ({ id: t.id, task: t, until })), ...pendingTasksRef.current.filter((p) => !r.tasks.some((t) => t.id === p.id))];
    // (sections left by an earlier failed try that this run reused are in r.sections too: merge by id)
    setSections((cur) => [...cur.filter((x) => !r.sections.some((y) => y.id === x.id)), ...r.sections]);
    setTasks((ts) => ts && [...r.tasks.filter((t) => !ts.some((x) => x.id === t.id)), ...ts]);
    requestReloadRef.current?.();
    (message.tone === "success" ? toastSuccess : message.tone === "error" ? toastError : toastInfo)(message.text);
    if (r.project) setRoute({ view: "project", projectId: r.project.id });
  }, [noteCreated, applyProjects, toastSuccess, toastError, toastInfo, setRoute]);

  /* ---- 0047 docs: "Make task" from a doc line, in the doc's project; resolves to the saved id (null: not made) ---- */
  const makeDocTask: DocMakeTask = useCallback(async ({ title, projectId }) => {
    if (denyGuest([projectWs(projectId)])) return null;
    return persistTask(unplanIfTheirs(applyAutomation(buildNewTask({ title, projectId, planToday: false }))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [denyGuest, persistTask, unplanIfTheirs, applyAutomation, buildNewTask]);

  /* ---- workspaces & people ---- */
  /** A new workspace; `start` sets it up from a team template once it exists. Resolves when
   *  everything is done (the dialog shows progress until then). */
  const createWorkspace = useCallback(async (name: string, start?: { template: WorkspaceTemplate; projectKeys?: string[] }) => {
    const me = getMember(userIdRef.current);
    let w: Workspace;
    try {
      w = await store.createWorkspace(name, { id: userIdRef.current, email: me?.email || "", name: me?.name || "You" });
    } catch (e) {
      reportError(e, { op: "createWorkspace" });
      toastError("Couldn't create the workspace: " + ((e as Error)?.message || e));
      return;
    }
    if (w.id) noteCreated(w.id); // a reload already under way doesn't know about it yet
    setWorkspaces((ws) => [...ws, w]);
    setWsMembers((m) => [...m, { id: "owner-" + w.id, workspaceId: w.id!, userId: userIdRef.current, email: me?.email || "", name: me?.name || "You", role: "owner", status: "active" }]);
    setReferenceData({ workspaces: [...workspacesRef.current, w] });
    setWorkspace(w.id);
    if (!start || !w.id) { setRoute({ view: "team" }); return; }
    // you own it, so the template's projects are yours to create; then show them
    const r = await applyTeamTemplate(start.template, start.projectKeys, w.id);
    setRoute(r?.projects.length ? { view: "projects" } : { view: "team" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toastError, noteCreated, applyTeamTemplate]);

  const updateWorkspace = useCallback((workspaceId: string, name: string, logoUrl: string | null) => {
    const before = workspacesRef.current;
    const next = before.map((w) => w.id === workspaceId ? { ...w, name, logoUrl: logoUrl ?? undefined } : w);
    setWorkspaces(next); setReferenceData({ workspaces: next });
    store.updateWorkspace(workspaceId, name, logoUrl).catch((e) => {
      reportError(e, { op: "updateWorkspace" });
      setWorkspaces(before); setReferenceData({ workspaces: before });
      toastError("Couldn't save workspace settings: " + (e?.message || e));
    });
  }, [toastError]);

  const uploadWorkspaceLogo = useCallback(async (workspaceId: string, file: File) => {
    try {
      const url = await store.uploadWorkspaceLogo(workspaceId, file, userIdRef.current);
      const ws = workspacesRef.current.find((w) => w.id === workspaceId);
      updateWorkspace(workspaceId, ws?.name || "Workspace", url);
    } catch (e) { reportError(e, { op: "uploadWorkspaceLogo" }); toastError("Couldn't upload the logo: " + ((e as Error)?.message || e)); }
  }, [updateWorkspace, toastError]);

  const deleteWorkspace = useCallback((workspaceId: string) => {
    store.deleteWorkspace(workspaceId)
      .then(() => {
        const next = workspacesRef.current.filter((w) => w.id !== workspaceId);
        setWorkspaces(next); setReferenceData({ workspaces: next });
        setWsMembers((m) => m.filter((x) => x.workspaceId !== workspaceId));
        setWorkspace(null); setRoute({ view: "plan" }, { replace: true });
        toastSuccess("Workspace closed");
      })
      .catch((e) => { reportError(e, { op: "deleteWorkspace" }); toastError("Couldn't close the workspace: " + (e?.message || e)); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toastError, toastSuccess]);

  const refreshWorkspaceMembers = useCallback(() => {
    store.listWorkspaceMembers().then(setWsMembers).catch((e) => reportError(e, { op: "refreshWorkspaceMembers" }));
  }, []);

  // TeamView awaits this: it shows the outcome — and how the invite email went — next
  // to the field, so nothing is toasted here. Refusals the person can act on
  // ("already a member", not allowed) aren't errors worth reporting.
  const inviteMember = useCallback((workspaceId: string, email: string, role: Role = "member") =>
    store.inviteMember(workspaceId, email, role).then((res) => {
      const { inviteEmail, ...m } = res; // the email result isn't member state
      setWsMembers((xs) => [...xs.filter((x) => x.id !== m.id), m]);
      if (inviteEmail?.reason === "already_active") refreshWorkspaceMembers();
      return res;
    }, (e) => {
      if (!/already a member|not authori[sz]ed|only the (workspace )?owner|only workspace owners|valid email|invalid role|choose a role/i.test(String(e?.message))) reportError(e, { op: "inviteMember" });
      throw e;
    }), [refreshWorkspaceMembers]);
  // "Resend invite" only re-sends the email (the invite itself stands)
  const resendInvite = useCallback((memberId: string) => store.sendInviteEmail(memberId).then((r) => {
    if (r.reason === "already_active") refreshWorkspaceMembers();
    return r;
  }), [refreshWorkspaceMembers]);

  const removeMember = useCallback((memberId: string) => {
    const m = wsMembersRef.current.find((x) => x.id === memberId);
    const leaving = !!m && m.userId === userIdRef.current;
    setWsMembers((xs) => xs.filter((x) => x.id !== memberId));
    store.removeMember(memberId)
      .then(() => {
        if (!leaving || !m) return;
        // you left: stop pointing at a workspace you're no longer in
        const name = workspacesRef.current.find((w) => w.id === m.workspaceId)?.name || "the workspace";
        const next = workspacesRef.current.filter((w) => w.id !== m.workspaceId);
        setWorkspaces(next); setReferenceData({ workspaces: next });
        if (workspaceRef.current === m.workspaceId) { setWorkspace(null); setRoute({ view: "plan" }, { replace: true }); }
        toastSuccess(`You left ${name}`);
      })
      .catch((e) => { reportError(e, { op: "removeMember" }); toastError("Couldn't remove them: " + (e?.message || e)); refreshWorkspaceMembers(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toastError, toastSuccess, refreshWorkspaceMembers]);

  const setMemberRole = useCallback((memberId: string, role: Role) => {
    setWsMembers((xs) => xs.map((m) => m.id === memberId ? { ...m, role } : m));
    store.setMemberRole(memberId, role).catch((e) => { reportError(e, { op: "setMemberRole" }); toastError("Couldn't change the role: " + (e?.message || e)); refreshWorkspaceMembers(); });
  }, [toastError, refreshWorkspaceMembers]);

  const setMemberTitle = useCallback((memberId: string, title: string) => {
    setWsMembers((xs) => xs.map((m) => m.id === memberId ? { ...m, title: title.trim() || undefined } : m));
    store.setMemberTitle(memberId, title).catch((e) => { reportError(e, { op: "setMemberTitle" }); toastError("Couldn't save the position: " + (e?.message || e)); refreshWorkspaceMembers(); });
  }, [toastError, refreshWorkspaceMembers]);

  const transferOwnership = useCallback((workspaceId: string, memberId: string) => {
    store.transferOwnership(workspaceId, memberId)
      .then(() => { toastSuccess("Ownership transferred"); refreshWorkspaceMembers(); })
      .catch((e) => { reportError(e, { op: "transferOwnership" }); toastError("Couldn't transfer ownership: " + (e?.message || e)); });
  }, [toastError, toastSuccess, refreshWorkspaceMembers]);

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

  /** Kanbo's order for your open tasks in this workspace (never teammates' work):
   *  the scores land on your own tasks, and in your overlay on tasks you only
   *  collaborate on. Resolves to where the order came from. `announce` says so in
   *  a toast (the palette's "Prioritise"); Today's Plan my day tells it its own way. */
  const appearanceRef = useRef(appearance); appearanceRef.current = appearance;
  const rankMyTasks = useCallback(async (announce = false): Promise<"ai" | "heuristic" | "none"> => {
    const cur = tasksRef.current; if (!cur) return "none";
    const ws = workspaceRef.current;
    if (denyGuest([ws])) return "none";
    const me = userIdRef.current;
    const archivedP = new Set(projectsRef.current.filter((p) => p.archivedAt).map((p) => p.id));
    const scope = cur.filter((t) => (t.workspaceId ?? null) === ws && t.status !== "done" && !t.archivedAt && !archivedP.has(t.projectId)
      && (t.assigneeId === me || (t.collaborators ?? []).includes(me)));
    if (!scope.length) { if (announce) toastInfo("Nothing open is assigned to you here yet."); return "none"; }
    // Kanbo AI switched off in Settings: nothing leaves the device, the order stays on-device
    if (appearanceRef.current.ai === false) { if (announce) toastSuccess("Sorted by Kanbo's order, on this device."); return "heuristic"; }
    setAiBusy(true);
    try {
      const res = await store.aiPrioritize(scope, toLocalISO(new Date()));
      const byId = new Map(scope.map((t) => [t.id, t]));
      const own = new Map<string, Partial<Task>>();
      let theirs = 0;
      for (const i of res.items) {
        const t = byId.get(i.id); if (!t) continue;
        const p = { aiScore: i.score, aiReason: i.reason };
        if (t.assigneeId === me) own.set(i.id, p);
        else { writeScoreOverlay(me, i.id, p); theirs++; }
      }
      applyLocal(own);
      own.forEach((p, id) => { writeTask(id, p).catch(() => { /* scores are advisory — a failed write just recomputes next time */ }); });
      if (theirs) setOverlayRev((n) => n + 1);
      if (announce) {
        toastSuccess(res.summary);
        // ranked without AI because the server said why (daily limit, awaiting approval): tell them
        const why = res.source === "heuristic" ? store.aiNotice() : null;
        if (why) toastInfo(why);
      }
      return res.source;
    } catch (e) {
      reportError(e, { op: "rankMyTasks" });
      if (announce) toastError("Couldn't prioritise right now.");
      return "none";
    } finally { setAiBusy(false); }
  }, [denyGuest, applyLocal, writeTask, toastSuccess, toastError, toastInfo]);
  const rankForToday = useCallback(() => rankMyTasks(false), [rankMyTasks]);
  // the palette's "Prioritise my tasks": My tasks in Kanbo's order, then rank
  const autoPrioritize = useCallback(() => {
    if (denyGuest([workspaceRef.current])) return;
    goRef.current({ view: "tasks" }); setSmart(true);
    void rankMyTasks(true);
  }, [denyGuest, rankMyTasks]);

  const openNewTask = useCallback((status: Status = "todo") => {
    const r = routeRef.current;
    const pid = r.view === "project" ? r.projectId : undefined;
    if (denyGuest([pid ? projectWs(pid) : workspaceRef.current])) return;
    // creating a task while viewing a project drops it into that project
    setNewTaskProjectId(pid);
    setNewTaskStatus(status); setNewTaskOpen(true);
  }, [denyGuest]);
  const openCapture = useCallback(() => {
    if (denyGuest([workspaceRef.current])) return;
    setQuickCaptureOpen(true);
  }, [denyGuest]);
  /** 0048 phone: the phone bar's + opens the quick add sheet (never for guests). */
  const openQuickAdd = useCallback(() => {
    if (denyGuest([workspaceRef.current])) return;
    setQuickAddOpen(true);
  }, [denyGuest]);
  /** Help › Take the tour (the TourHost mounts once a tour is wanted, and starts at step 1). */
  const startTourNow = useCallback(() => { setSidebarOpen(false); startTour({ from: "help" }); }, []);
  openNewTaskRef.current = () => openNewTask();
  openCaptureRef.current = openCapture;
  /** Import tasks: empty, or with text already in it (a paste too long for Quick capture). */
  const openImport = useCallback((text?: string) => {
    if (denyGuest([workspaceRef.current])) return;
    setImportText(text); setImportOpen(true);
  }, [denyGuest]);

  // opening Focus never resumes a paused timer by itself; "Start a focus block" does start it
  const openFocus = (start?: boolean) => { if (start === true && !focus.running) focus.setRunning(true); setFocusOpen(true); };
  openFocusRef.current = openFocus;
  // focus on one task: bank what was running for another task, then start fresh at this task's estimate
  const focusTask = (id: string) => {
    const t = tasksRef.current?.find((x) => x.id === id);
    if (focus.seconds > 0 && focus.taskId && focus.taskId !== id) focus.endSession();
    focus.setTaskId(id);
    if (!focus.pomodoro && t) focus.setTargetMin(Math.max(5, t.focusMin || t.dur || 30));
    setDetailId(null); setFocusOpen(true); focus.setRunning(true);
  };

  /** Settings: ⌘, and the Settings buttons open it plainly (Appearance on a desktop, the
   *  section list on a phone); a deep link opens at its section: Profile from your avatar,
   *  Shortcuts for ?, Calendar from Month and Today, Tags from Manage tags… Closing forgets
   *  the section, so the same deep link twice in a row still lands on it. */
  const openSettings = useCallback((section?: SettingsSection) => { setSettingsSection(section); setSettingsOpen(true); }, []);
  const closeSettings = useCallback(() => { setSettingsOpen(false); setSettingsSection(undefined); }, []);
  openSettingsRef.current = openSettings;
  /** The command bar; with `query` it opens on its Ask row with that text. */
  const openPalette = useCallback((query?: string) => { setPaletteQuery(query); setCmdOpen(true); }, []);
  useEffect(() => { if (!cmdOpen) setPaletteQuery(undefined); }, [cmdOpen]); // however it closed
  /** Paste notes → tasks: empty, or with the notes (and what they're from) already in. */
  const openExtract = useCallback((text?: string, context?: string) => {
    if (denyGuest([workspaceRef.current])) return;
    setQuickCaptureOpen(false);
    setExtract({ open: true, text, context });
  }, [denyGuest]);

  /** A workspace switch keeps the page when it still makes sense there: otherwise
   *  the same place's first page (Personal's Team is Insights), or Today. */
  const switchWorkspace = useCallback((id: string | null) => {
    if (id === workspaceRef.current) return;
    setWorkspace(id);
    const r = routeRef.current;
    if (r.view === "project") {
      const p = projectsRef.current.find((x) => x.id === r.projectId);
      if (!p || p.archivedAt || (p.workspaceId ?? null) !== id) setRoute({ view: "plan" });
    } else if (id === null && (r.view === "pulse" || r.view === "team" || r.view === "workload")) setRoute({ view: "analytics" });
    else if (roleIn(id) === "guest" && r.view === "automations") setRoute({ view: "projects" });
  }, [roleIn, setRoute]);

  /** Take back tasks created a moment ago (an undone Ask), without a delete toast of their own. */
  const discardCreated = useCallback((ids: string[]) => {
    const all = tasksRef.current ?? [];
    const rows = [...all.filter((t) => ids.includes(t.id)), ...descendantsOf(ids, all)];
    if (!rows.length) return;
    const gone = new Set(rows.map((r) => r.id));
    setTasks((ts) => ts && ts.filter((x) => !gone.has(x.id)));
    noteDelete([...gone]); dropPending(gone);
    serverDelete(rows).then((failed) => { if (failed.length) toastError(`${plural(failed.length, "new task")} couldn't be taken back — delete ${failed.length === 1 ? "it" : "them"} by hand.`); });
  }, [noteDelete, dropPending, serverDelete, toastError]);

  /** Ask Kanbo's Apply: the changes it proposed (validated upstream: allowed fields,
   *  no deletes), then one Undo (and ⌘Z) that puts back every field it changed and
   *  takes back what it created. Plan fields go through the plan-state guard. */
  const applyAskActions = useCallback((actions: AskAction[]) => {
    // what each change replaced, newest last: Undo walks back through them in reverse,
    // so two changes to one task put back what was there before the first
    const undos: GuardedUndo[] = [];
    const created: string[] = [];
    const me = userIdRef.current;
    let n = 0;
    for (const a of actions) {
      if (a.op === "update") {
        if (!Object.keys(a.patch).length) continue;
        const u = guardedWrite(a.id, a.patch);
        if (!u) continue;
        undos.push(u); n++;
      } else if (a.op === "create") {
        const { planToday, ...fields } = a.task;
        const t0 = applyAutomation(buildNewTask(fields));
        // "on today" for someone else's new task is your plan, not theirs
        const mine = !t0.assigneeId || t0.assigneeId === me;
        const t = mine ? (planToday !== undefined ? { ...t0, planToday } : t0) : unplanIfTheirs(t0);
        if (denyGuest([projectWs(t.projectId)])) continue;
        persistTask(t);
        if (!mine && planToday) writeOverlay(t, { planToday: true });
        noteElsewhere([t.projectId]);
        created.push(t.id); n++;
      } else if (a.op === "open") {
        if (a.taskId) setDetailId(a.taskId);
        else if (a.route) setRoute(a.route);
      }
    }
    if (!n) return;
    toastAction(`Applied ${plural(n, "change")}`, "Undo", () => {
      [...undos].reverse().forEach(undoGuarded);
      if (created.length) discardCreated(created);
    }, {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guardedWrite, undoGuarded, applyAutomation, buildNewTask, unplanIfTheirs, writeOverlay, denyGuest, persistTask, noteElsewhere, discardCreated, toastAction]);

  /** Waiting on: ask the assignee for an update, in a comment that mentions them. */
  const nudge = useCallback((taskId: string) => {
    const t = tasksRef.current?.find((x) => x.id === taskId);
    if (!t?.assigneeId || t.assigneeId === userIdRef.current) return;
    const first = (getMember(t.assigneeId)?.name || "").trim().split(/\s+/)[0] || "there";
    void addComment(taskId, `@${first} — any update on this?`, [t.assigneeId]).then((c) => { if (c) toastSuccess(`Nudged ${first}`); });
  }, [addComment, toastSuccess]);

  /* ---- 0048 drops (lib/dnd + lib/dropActions): tasks let go on a project, a person or Today ---- */
  /** Per-task patches through App's own rules (as any edit): guests refused, the workspace follows the project,
   *  sub-tasks go with their parent, a plan is released with the task. One save; the caller says it with Undo. */
  const applyMovePatches = useCallback((list: { id: string; patch: Partial<Task> }[]) => {
    const all = tasksRef.current ?? [];
    const patches = new Map<string, Partial<Task>>();
    const notes = new Set<string>();
    const wsIds: (string | null | undefined)[] = [];
    for (const { id, patch: given } of list) {
      const prev = all.find((t) => t.id === id); if (!prev) continue;
      const p: Partial<Task> = { ...given };
      const note = retarget(prev, p); if (note) notes.add(note);
      Object.assign(p, releasedPlan(prev, p));
      wsIds.push(prev.workspaceId, "workspaceId" in p ? p.workspaceId : undefined);
      if (Object.keys(p).length) { patches.set(id, p); cascadeToDescendants(prev, p, all, patches); }
    }
    if (!patches.size || denyGuest(wsIds)) return;
    updateTasks(patches);
    if (notes.size === 1) toastInfo([...notes][0]);
  }, [retarget, cascadeToDescendants, denyGuest, updateTasks, toastInfo]);
  const moveDeps = useCallback((): MoveDeps => ({
    tasks: tasksRef.current ?? [], updateTasks: applyMovePatches,
    toast: (m, undo) => { if (undo) toastAction(m, "Undo", undo, {}); else toastInfo(m); },
    sections: sectionsRef.current, members: wsMembersRef.current,
  }), [applyMovePatches, toastAction, toastInfo]);
  const dropOnProject = useCallback((ids: string[], projectId: string) => {
    const p = projectsRef.current.find((x) => x.id === projectId);
    if (p) moveTasksToProject(ids, p, moveDeps());
  }, [moveDeps]);
  const dropOnPerson = useCallback((ids: string[], userId: string) => {
    const name = getMember(userId)?.name || wsMembersRef.current.find((m) => m.userId === userId)?.name || "them";
    reassignTasks(ids, { id: userId, name }, moveDeps());
  }, [moveDeps]);
  /** Today in the sidebar: on today's list (no time), your plan on teammates' tasks; one Undo for them all. */
  const dropOnToday = useCallback((ids: string[]) => {
    const me = userIdRef.current;
    const mine = (seenRef.current ?? []).filter((t) => t.assigneeId === me || (t.collaborators ?? []).includes(me));
    const r = todayListPatches(mine, ids);
    if (!r.patches.length) { toastInfo(r.message); return; }
    const undos = r.patches.map((x) => guardedWrite(x.id, x.patch)).filter((u): u is GuardedUndo => !!u);
    if (undos.length) toastAction(r.message, "Undo", () => [...undos].reverse().forEach(undoGuarded), {});
  }, [guardedWrite, undoGuarded, toastAction, toastInfo]);

  /* ---- 0048 templates: a template's whole plan through App's create paths ---- */
  /** The task (rules run, as for any new task), its sub-tasks under it (each waits for its insert), then its
   *  checklist once it's saved. On Today a task of yours lands on today's plan; elsewhere it doesn't. */
  const applyTemplatePlan = useCallback((plan: AppliedTemplatePlan) => {
    import("./lib/templatePlan").then(({ templateTasks }) => {
      const onToday = routeRef.current.view === "plan";
      const { task, subtasks, checklist } = templateTasks(plan, (p) => buildNewTask(p));
      const parent = unplanIfTheirs(applyAutomation({ ...task, planToday: onToday ? task.planToday : false }));
      if (denyGuest([projectWs(parent.projectId)])) return;
      const created = persistTask(parent);
      subtasks.forEach((sub) => persistTask({ ...sub, projectId: parent.projectId, parentId: parent.id }, { log: false }));
      copyChecklist(created, checklist);
      noteElsewhere([parent.projectId]);
    }, (e: unknown) => { reportError(e, { op: "applyTemplatePlan" }); toastError("Couldn't use that template. Check your connection and try again."); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildNewTask, unplanIfTheirs, applyAutomation, denyGuest, persistTask, copyChecklist, noteElsewhere, toastError]);
  /** New task ▾ › From a template… (and the palette): the library. Never for guests. */
  const openTemplateLibrary = useCallback((initialTemplateId?: string) => {
    if (denyGuest([workspaceRef.current])) return;
    setTemplateLibrary({ open: true, initialTemplateId });
  }, [denyGuest]);
  /** The library's "Use template": New task opens with it applied (it's checked, then created). */
  const applyLibraryTemplate = useCallback((t: LibraryTemplate) => {
    setTemplateLibrary({ open: false });
    const r = routeRef.current;
    const pid = r.view === "project" ? r.projectId : undefined;
    if (denyGuest([pid ? projectWs(pid) : workspaceRef.current])) return;
    setNewTaskProjectId(pid); setNewTaskStatus("todo"); setNewTaskTemplate(t); setNewTaskOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [denyGuest]);

  /* ---- 0048 first run: the "Kanbo tour" sample project (Help menu) ---- */
  // Made in Personal through the store, shown at once, kept through any reload already under way.
  const sampleDeps = useMemo((): TourSampleDeps => ({
    createProject: async (input) => {
      const me = userIdRef.current;
      const p = await store.createProject({ name: input.name, emoji: input.emoji, color: input.color, workspaceId: input.workspaceId }, me);
      noteCreated(p.id);
      let full: Project = p;
      if (input.description) {
        full = { ...p, description: input.description };
        await store.updateProject(p.id, { description: input.description }).catch((e) => reportError(e, { op: "sampleDescription" }));
      }
      applyProjects([...projectsRef.current.filter((x) => x.id !== p.id), full]);
      return full;
    },
    createTasks: async (rows) => {
      const saved = await store.createTasksBatch(rows, userIdRef.current);
      const until = Date.now() + 30000;
      const ids = new Set(saved.map((t) => t.id));
      pendingTasksRef.current = [...saved.map((t) => ({ id: t.id, task: t, until })), ...pendingTasksRef.current.filter((x) => !ids.has(x.id))];
      setTasks((ts) => (ts ? [...saved.filter((t) => !ts.some((x) => x.id === t.id)), ...ts] : saved));
      return saved;
    },
    addDependency: async (taskId, dependsOn) => {
      await store.addDependency(taskId, dependsOn);
      setTasks((ts) => ts && ts.map((t) => (t.id === taskId ? { ...t, dependencies: [...new Set([...(t.dependencies ?? []), dependsOn])] } : t)));
    },
    createDoc: async (projectId, title, body) => {
      const { saveProjectDoc } = await import("./lib/docs");
      const r = await saveProjectDoc({ id: newTaskId(), projectId, title, body, baseUpdatedAt: null });
      return { id: r.doc.id };
    },
    deleteProject: async (projectId) => {
      await store.deleteProject(projectId);
      if (routeRef.current.view === "project" && routeRef.current.projectId === projectId) setRoute({ view: "plan" }, { replace: true });
      const gone = new Set((tasksRef.current ?? []).filter((t) => t.projectId === projectId).map((t) => t.id));
      applyProjects(projectsRef.current.filter((p) => p.id !== projectId));
      setTasks((ts) => ts && ts.filter((t) => !gone.has(t.id)));
      noteDelete([...gone]); dropPending(gone);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [noteCreated, applyProjects, noteDelete, dropPending]);
  const trySample = useCallback(() => {
    if (sampleBusy) return;
    setSampleBusy(true);
    createTourSample(sampleDeps, { today: new Date(KANBO_TODAY), currentUserId: userIdRef.current, workspaceId: null, current: onboardingRef.current })
      .then((state) => {
        adoptOnboarding(state);
        const pid = state.sample?.projectId;
        if (pid) { setWorkspace(null); setRoute({ view: "project", projectId: pid }); }
        toastSuccess("The sample project “Kanbo tour” is in Personal");
      }, (e: unknown) => {
        // (checked by name, not instanceof: the sample's code stays in its own chunk)
        const named = (e as { name?: string; message?: string } | null);
        if (named?.name !== "TourSampleError") reportError(e, { op: "createTourSample" });
        toastError(named?.name === "TourSampleError" && named.message ? named.message : "Couldn't make the sample project. Check your connection and try again.");
      })
      .finally(() => setSampleBusy(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sampleBusy, sampleDeps, adoptOnboarding, toastSuccess, toastError]);
  const removeSample = useCallback(() => {
    if (sampleBusy) return;
    setSampleBusy(true);
    removeTourSample(sampleDeps, onboardingRef.current)
      .then((state) => { adoptOnboarding(state); toastSuccess("The sample project went to the recycle bin"); },
        (e: unknown) => { reportError(e, { op: "removeTourSample" }); toastError("Couldn't remove the sample project. Try again, or delete “Kanbo tour” from its menu."); })
      .finally(() => setSampleBusy(false));
  }, [sampleBusy, sampleDeps, adoptOnboarding, toastSuccess, toastError]);

  /** "Get set up": each item's button takes you where it's done. */
  const onSetupAction = useCallback((id: SetupItemId) => {
    switch (id) {
      case "invite_team":
        if (workspaceRef.current === null) setNewWorkspaceOpen(true); else setRoute({ view: "team" });
        break;
      // (the Slack panel lives in the same section as the calendars)
      case "connect_calendar": case "connect_slack": openSettings("calendar"); break;
      // company domains are a site admin's setting: the admin page (only offered to them)
      case "add_domain": window.location.assign("/admin"); break;
      case "plan_day": {
        // the card is on Today: Plan my day itself (P), else Today
        const btn = document.querySelector<HTMLButtonElement>('[data-tour="plan-day"]');
        if (routeRef.current.view === "plan" && btn && !btn.disabled) btn.click(); else setRoute({ view: "plan" });
        break;
      }
      case "complete_task": setRoute({ view: "tasks" }); break;
      // the browser's own install prompt where it has one; otherwise Settings › Notifications › Kanbo app explains
      case "install_app": void promptInstall().then((r) => { if (r === "unavailable") openSettings("notifications"); }, () => openSettings("notifications")); break;
      case "set_notifications": openSettings("notifications"); break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setRoute]);

  /** Inbox › Archived › Move back to Inbox: the items archived here come back. */
  const unarchiveInbox = useCallback((ids: string[]) => {
    const parts = ids.map((id) => archivedHereRef.current.get(id)).filter((p): p is { item: Activity; archived: Promise<void> } => !!p);
    if (!parts.length) return;
    ids.forEach((id) => archivedHereRef.current.delete(id));
    setArchivedRev((n) => n + 1);
    undoArchive(parts.map((p) => ({ items: [p.item], archived: p.archived })));
  }, [undoArchive]);

  // Early-access gate: a platform admin is always let through — by the profile's
  // is_admin flag, or else by asking the server (is_admin(), which also knows the
  // founding account and, once 0042 is live, says no for a suspended admin).
  // Only asked when the gate would otherwise stop someone.
  const gated = auth.configured && !!profile && (profile.suspended === true || profile.approved === false);
  const adminByFlag = !!profile?.isAdmin && profile.suspended !== true;
  const [adminCheck, setAdminCheck] = useState<{ uid: string; admin: boolean } | null>(null);
  useEffect(() => {
    if (!gated || adminByFlag || !authUserId) return;
    let alive = true;
    // never leave someone on the loader if the check stalls — after 6s treat it as "not an admin"
    const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 6000));
    Promise.race([store.amIAdmin(), timeout])
      .then((admin) => { if (alive) setAdminCheck({ uid: authUserId, admin }); }, () => { if (alive) setAdminCheck({ uid: authUserId, admin: false }); });
    return () => { alive = false; };
  }, [gated, adminByFlag, authUserId]);
  const adminChecked = adminCheck?.uid === authUserId;
  const letAdminIn = adminByFlag || (adminChecked && adminCheck!.admin);

  // "today" moved on (a tab left open overnight): day-based counts are recomputed
  const [dayKey, setDayKey] = useState(() => toLocalISO(KANBO_TODAY));
  useEffect(() => {
    const onDay = () => setDayKey(toLocalISO(KANBO_TODAY));
    window.addEventListener(DAY_CHANGE_EVENT, onDay);
    return () => window.removeEventListener(DAY_CHANGE_EVENT, onDay);
  }, []);
  // What this person sees on their own surfaces (Today, Week, My tasks, Inbox, Search,
  // the palette, the task panel): on tasks assigned to someone else, their own plan
  // (slot, "on today", My-tasks section, Kanbo's order) instead of the assignee's.
  // Team and project views keep each task's own row: a teammate's plan is theirs to show.
  const tasksSeen = useMemo(() => (tasks ? withOverlay(tasks, currentUserId, dayKey) : null),
    // (overlayRev: this person just changed their plan on someone else's task)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tasks, currentUserId, dayKey, overlayRev]);
  seenRef.current = tasksSeen;
  useEffect(() => { if (tasks !== null) prunePlanOverlay(currentUserId); }, [currentUserId, dayKey, tasks === null]); // eslint-disable-line react-hooks/exhaustive-deps
  // scope everything to the active workspace (memoised: the focus timer re-renders
  // App every second, and the Sidebar's badge counts key off this list)
  const inWorkspace = useCallback((list: Task[]) => {
    const archivedProjectIds = new Set(projects.filter((p) => p.archivedAt).map((p) => p.id));
    return list.filter((t) => (t.workspaceId ?? null) === workspace && !t.archivedAt && !archivedProjectIds.has(t.projectId));
  }, [projects, workspace]);
  const allTasks = useMemo(() => inWorkspace(tasks ?? []), [tasks, inWorkspace]);
  const allSeen = useMemo(() => (tasksSeen === tasks ? allTasks : inWorkspace(tasksSeen ?? [])), [tasksSeen, tasks, allTasks, inWorkspace]);
  // Radar: the workspace's risks (blockers, slips, stale work, over capacity), for the
  // sidebar's Team badge, Today's brief and each project's notice line
  const risks = useMemo(() => {
    if (tasks === null || workspace === null) return [];
    const members = wsMembers.filter((m) => (m.workspaceId ?? null) === workspace && m.status === "active" && m.userId)
      // (guests' work shows, but they carry no team capacity)
      .map((m) => ({ id: m.userId!, name: getMember(m.userId!)?.name || m.name || m.email, ...(m.role === "guest" ? { guest: true } : {}) }));
    return computeRisks({ tasks: allTasks, members, capacities: readCapacities(), today: dayKey });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allTasks, wsMembers, workspace, dayKey]);
  const signalRisks = risks.filter((r) => r.severity === "signal").length;
  /* ---- 0048 saved views (lib/views): the Sidebar's Views, My tasks' links, ?view= and /search/list/:id ---- */
  // (off until the real account is known: before bootstrap the id is the "m-self" placeholder)
  const sv = useSavedViews(workspace, currentUserId, { enabled: tasks !== null && (!store.configured || currentUserId !== "m-self") });
  // A search view's count is the Search view's own task rule (lib/search/searchSpec), fetched while the browser
  // is idle so the search chunk stays out of the first download; until then its words count literally.
  const [searchSpec, setSearchSpec] = useState<typeof import("./lib/search/searchSpec") | null>(null);
  const wantsSearchSpec = sv.views.some((v) => v.kind === "search");
  useEffect(() => {
    if (!wantsSearchSpec || searchSpec) return;
    let alive = true;
    const cancel = whenIdle(() => { import("./lib/search/searchSpec").then((m) => { if (alive) setSearchSpec(m); }, () => undefined); }, 4000);
    return () => { alive = false; cancel(); };
  }, [wantsSearchSpec, searchSpec]);
  // live counts over every task you can see (personal search views span workspaces), as Search counts them
  const savedViewCounts = useMemo(() => {
    const all = tasksSeen ?? [];
    const out: Record<string, number | null> = viewCounts(sv.views, { tasks: all, currentUserId, today: KANBO_TODAY });
    if (searchSpec) {
      const people = [...new Map([[currentUserId, getMember(currentUserId)?.name || "You"], ...wsMembers.filter((m) => m.status === "active" && m.userId).map((m) => [m.userId!, getMember(m.userId!)?.name || m.name || m.email] as [string, string])]).entries()].map(([id, name]) => ({ id, name }));
      const ctx = { members: people, projects, currentUserId, today: dayKey };
      const byId = new Map(projects.map((p) => [p.id, p]));
      for (const v of sv.views) {
        if (v.kind !== "search") continue;
        try {
          const { input, panel } = searchSpec.searchFromViewQuery(v.query, ctx);
          const r = searchSpec.resolveSearch(input, panel, ctx, dayKey);
          out[v.id] = r.active && r.kinds.includes("task") ? searchSpec.localTaskMatches(all, r, (id) => byId.get(id)).length : null;
        } catch { /* keep the literal count */ }
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sv.views, tasksSeen, currentUserId, dayKey, searchSpec, projects, wsMembers]);
  // the saved view the page shows (?view= on My tasks or a project): the page starts from it
  const appliedView = route.savedViewId ? getSavedView(route.savedViewId) : undefined;
  const viewStart = useMemo(() => (appliedView ? viewPageStart(appliedView, currentUserId) : undefined), [appliedView, currentUserId]);
  // a project list's grouping while a view is applied is the view's (never saved over the project's own)
  const [viewGroup, setViewGroup] = useState<{ viewId: string; groupBy: GroupBy } | null>(null);

  // your tasks in every workspace (a streak and a week's wins are yours, not a team's): one array per change, not
  // per render — App re-renders every second while the focus timer runs
  const myTasksEverywhere = useMemo(() => (tasksSeen ?? []).filter((t) => t.assigneeId === currentUserId || (t.collaborators ?? []).includes(currentUserId)), [tasksSeen, currentUserId]);

  /* ---- 0048 first run: who the tour and the "Get set up" card are for, and what the app can see ---- */
  const roleHere = wsMembers.find((m) => m.userId === currentUserId && (m.workspaceId ?? null) === workspace && m.status === "active")?.role ?? null;
  const tourRole = tourRoleOf(roleHere, workspace === null);
  // a brand-new account: the first-run sheet opened this session, or it was made in the last week
  const createdAt = auth.user?.createdAt;
  const isNewAccount = firstRunHere || (!!createdAt && Date.now() - Date.parse(createdAt) < 7 * 86_400_000);
  // facts the card ticks itself from (each fetched only while the card can use it)
  const setupLive = tasks !== null && !onboarding.checklist?.dismissedAt;
  const [pushHere, setPushHere] = useState(false);
  useEffect(() => { if (setupLive && tourRole !== "owner") isPushOnHere().then(setPushHere, () => undefined); }, [setupLive, tourRole]);
  const [slackOn, setSlackOn] = useState(false);
  useEffect(() => {
    setSlackOn(false);
    if (!setupLive || tourRole !== "owner" || workspace === null) return;
    let alive = true, off = () => {};
    import("./lib/slack").then((m) => {
      if (!alive) return;
      m.getSlackStatus(workspace).then((st) => { if (alive) setSlackOn(!!st?.connected); }, () => undefined);
      off = m.onSlackStatusChange((ws, st) => { if (alive && ws === workspace) setSlackOn(!!st?.connected); });
    }, () => undefined);
    return () => { alive = false; off(); };
  }, [setupLive, tourRole, workspace]);
  const [companyDomains, setCompanyDomains] = useState(0);
  useEffect(() => {
    if (!setupLive || !adminByFlag || !store.configured) return;
    store.listApprovedDomains().then((d) => setCompanyDomains(d.length), () => undefined);
  }, [setupLive, adminByFlag]);
  const setupFacts = setupSignals({
    teammates: wsMembers.filter((m) => (m.workspaceId ?? null) === workspace && m.userId !== currentUserId).length,
    calendars: calConnections.length, companyDomains, slack: slackOn,
    plannedToday: allSeen.some((t) => (t.assigneeId === currentUserId || (t.collaborators ?? []).includes(currentUserId)) && (t.scheduled != null || !!t.planToday)),
    completedAny: allTasks.some((t) => t.status === "done" && t.assigneeId === currentUserId),
    installed: isStandalone() || installState() === "installed",
    notificationsChosen: pushHere || Object.keys(profile?.notifyPrefs ?? {}).length > 0,
  });
  // the company domain is a site admin's setting; Personal has no Slack
  const setupHidden = useMemo<SetupItemId[]>(() => [...(adminByFlag ? [] : ["add_domain" as const]), ...(workspace === null ? ["connect_slack" as const] : [])], [adminByFlag, workspace]);
  const showSetup = useShowSetupChecklist(tourRole, onboarding, setupFacts, { hidden: setupHidden });
  // dismissed before it was finished: Help offers it back
  const setupProgress = checklistProgress(tourRole, onboarding, setupFacts, { hidden: setupHidden });
  const setupDismissedEarly = !!onboarding.checklist?.dismissedAt && setupProgress.total > 0 && !setupProgress.complete;
  useEffect(() => { if (route.view !== "search" && searchPrefill) setSearchPrefill(null); }, [route.view, searchPrefill]);

  // The app itself is on screen (not the sign-in site, a password link, the loader,
  // the waiting room or the paywall): only then does it own the address and the title.
  const shellShown = (!auth.configured || (!!auth.user && !auth.loading)) && !auth.recovery && tasks !== null
    && !(gated && !letAdminIn) && !(subscription && !hasAccess(subscription));
  shellShownRef.current = shellShown;
  // Code for the places someone is likely to go next is fetched while the browser is
  // idle, once the shell is up and again on each new place (its own tabs first), then
  // every other screen's, so the app works offline as it did when it was one file
  const idlePlace = placeOf(route);
  useEffect(() => {
    if (!shellShown || import.meta.env.MODE === "test") return;
    const wsId = workspaceRef.current, role = roleIn(wsId);
    const ctx = { personal: wsId === null, guest: role === "guest", admin: role === "owner" || role === "admin" };
    // (0048: the Schedule… / Move to… menus too, so the keyboard way to plan opens at once)
    const menus = canPrefetchAhead() ? whenIdle(prefetchPlanMenus, 8000) : () => {};
    const stop = prefetchWhenIdle([...likelyNext(routeRef.current, ctx), ...everyScreen()]);
    return () => { menus(); stop(); };
  }, [shellShown, idlePlace, workspace, roleIn]);
  // …and a link (a tab in the page header, a crumb) starts fetching its page when
  // the pointer or focus lands on it (the sidebar and phone bar do this themselves)
  const hoveredHrefRef = useRef("");
  const prefetchLink = useCallback((e: React.SyntheticEvent) => {
    const link = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!link || link.href === hoveredHrefRef.current) return;
    hoveredHrefRef.current = link.href;
    try {
      const u = new URL(link.href, window.location.href);
      if (u.origin === window.location.origin) prefetchRoute(routeOf(u.pathname, u.search));
    } catch { /* not an address */ }
  }, []);
  // keep the address in step: the route's canonical path (an old one like /home is
  // rewritten), ?task= while a task is open, ?q= for text handed to Search
  useEffect(() => {
    if (!shellShown) return;
    writeUrl(addressFor(route, { task: detailId, q: searchPrefill?.text }, window.location.search), "replace");
  }, [shellShown, route, detailId, searchPrefill, writeUrl]);
  // the tab's title: the page, then Kanbo, with the unread count first so a background tab still tells you
  const baseTitleRef = useRef(typeof document !== "undefined" ? document.title.replace(/^\(\d+\)\s*/, "") : "Kanbo");
  const pageTitle = route.view === "project" ? projects.find((p) => p.id === route.projectId)?.name || "Project" : titleOf(route, { personal: workspace === null });
  useEffect(() => {
    document.title = shellShown ? `${newCount > 0 ? `(${newCount}) ` : ""}${pageTitle} · Kanbo` : baseTitleRef.current;
  }, [shellShown, pageTitle, newCount]);
  // Screen readers hear where you've gone: a new page (a place, or another project) is
  // announced by name. A tab switch isn't: the tab you pressed already says so.
  const [announced, setAnnounced] = useState("");
  const lastPageRef = useRef<string | null>(null);
  const page = pageOf(route);
  useEffect(() => {
    if (!shellShown) return;
    const prev = lastPageRef.current; lastPageRef.current = page;
    if (prev !== null && prev !== page) setAnnounced(pageTitle);
  }, [shellShown, page, pageTitle]);
  // someone new to Kanbo never needs "What moved" (they get "Your five places" in the tour)
  useEffect(() => { if (shellShown && !knewOldLayout) markWhatMovedSeen(); }, [shellShown, knewOldLayout]);
  // 16:00–18:00 Today's header offers "Shut down" (after 18:00 it's the brief's own hero);
  // flips when the phase changes, not every minute
  const [lateDay, setLateDay] = useState(isLateDay);
  useEffect(() => subscribeMinute(() => setLateDay(isLateDay())), []);

  // ---- auth / loading gates ----
  // (in the real page Root answers these three first, so the app's code is only fetched once someone is signed in)
  if (auth.recovery) return <Suspense fallback={<FullLoader />}><UpdatePasswordScreen /></Suspense>;
  // still restoring the session: a loader, never a flash of the marketing site
  if (auth.configured && auth.loading) return <FullLoader />;
  if (auth.configured && !auth.user) return <Suspense fallback={<FullLoader />}><PublicSite /></Suspense>;
  if (auth.loading || tasks === null) return <FullLoader />;
  // Early-access gate: a brand-new account stays in a waiting room until an admin
  // approves it. Fail-open — only blocks when we KNOW approved === false (or
  // suspended), never on a load hiccup — and platform admins are let through.
  if (gated && !letAdminIn) {
    if (!adminByFlag && !adminChecked) return <FullLoader />; // asking the server whether this is an admin
    return (
      <Suspense fallback={<FullLoader />}>
        {profile!.suspended === true
          ? <PendingApproval email={auth.user?.email} onSignOut={auth.signOut} suspended />
          : <PendingApproval email={auth.user?.email} onSignOut={auth.signOut} />}
      </Suspense>
    );
  }
  if (subscription && !hasAccess(subscription)) {
    const seats = Math.max(1, wsMembers.filter((m) => m.status === "active").length || 1);
    return <Suspense fallback={<FullLoader />}><Paywall sub={subscription} seats={seats} busyPlan={checkoutBusy} onChoose={startCheckout} onManageBilling={manageBilling} onSignOut={auth.configured ? auth.signOut : undefined} /></Suspense>;
  }

  // "mine": assigned to me or I'm a collaborator. Planning, Focus and My week are
  // personal — they never show (or schedule) teammates' work.
  const seen = tasksSeen ?? tasks;
  const isMine = (t: Task) => t.assigneeId === currentUserId || (t.collaborators ?? []).includes(currentUserId);
  const myTasks = allSeen.filter(isMine);
  // "Show archived" follows the page: this project's archived tasks, or mine in My tasks
  const wsArchived = seen.filter((t) => (t.workspaceId ?? null) === workspace && !!t.archivedAt);
  const archivedTasks = route.view === "project" && route.projectId ? wsArchived.filter((t) => t.projectId === route.projectId) : wsArchived.filter(isMine);
  // /search/list/:id: a smart list, or a saved search view (lib/views; old saved searches were adopted into them)
  const searchSaved = route.view === "search" && route.list ? getSavedView(route.list) : undefined;
  const searchView = searchSaved?.kind === "search" ? searchSaved : undefined;
  const searchPreset = smartListQuery(route.list, currentUserId) ?? (searchPrefill ? { text: searchPrefill.text } : undefined);
  const searchPresetKey = route.list ?? searchPrefill?.key;

  const activeWsName = workspaces.find((w) => w.id === workspace)?.name || "Personal";
  const myRole = wsMembers.find((m) => m.userId === currentUserId && (m.workspaceId ?? null) === workspace && m.status === "active")?.role;
  // guests can view and comment only — views can use these to hide editing controls
  const activeReadOnly = myRole === "guest";
  const isAdmin = myRole === "owner" || myRole === "admin";
  const personal = workspace === null;
  const navCtx: NavCtx = { personal, guest: activeReadOnly, admin: isAdmin };
  const aiOn = appearance.ai !== false;
  const detailTask = detailId ? seen.find((t) => t.id === detailId) : undefined;
  const detailReadOnly = !!detailTask && roleIn(detailTask.workspaceId) === "guest";

  // scope tasks by route: "My tasks" stays within the workspace you're viewing — your
  // personal tasks never mix with a team workspace's, and vice versa
  const openProject = route.view === "project" && route.projectId ? getProject(route.projectId) : undefined;
  const scoped = route.view === "tasks" ? myTasks : openProject ? allTasks.filter((t) => t.projectId === openProject.id) : allTasks;
  const wsProjects = projects.filter((p) => (p.workspaceId ?? null) === workspace && !p.archivedAt);
  // people you can assign/tag: active members of the ACTIVE workspace only, by
  // their profile name (then their invite name, then email). Personal resolves
  // to just you — you can never tag someone from another workspace.
  const personName = (m: WorkspaceMember) => getMember(m.userId ?? "")?.name || m.name || m.email;
  const assignees = (() => {
    const active = wsMembers.filter((m) => m.status === "active" && m.userId && (m.workspaceId ?? null) === workspace).map((m) => ({ id: m.userId!, name: personName(m) }));
    return active.length > 0 ? active : [{ id: currentUserId, name: getMember(currentUserId)?.name || "You" }];
  })();
  // the same people as Member[] (doc @mentions, the approvals group): guests are "external"
  const wsPeople: Member[] = (() => {
    const here = wsMembers.filter((m) => m.status === "active" && m.userId && (m.workspaceId ?? null) === workspace).map((m): Member => {
      const known = getMember(m.userId!);
      return { id: m.userId!, name: known?.name || personName(m), email: m.email, type: m.role === "guest" ? "external" : known?.type === "self" ? "self" : "team", color: known?.color ?? SELF_COLOR };
    });
    if (here.length) return here;
    const me = getMember(currentUserId);
    return [me ?? { id: currentUserId, name: "You", email: "", type: "self", color: SELF_COLOR }];
  })();
  // Search spans every workspace, so its people filter does too
  const everyone = (() => {
    const names = new Map<string, string>([[currentUserId, getMember(currentUserId)?.name || "You"]]);
    wsMembers.forEach((m) => { if (m.status === "active" && m.userId && !names.has(m.userId)) names.set(m.userId, personName(m)); });
    return [...names].map(([id, name]) => ({ id, name }));
  })();

  const currentUser = getMember(currentUserId);
  const wsKey = workspace ?? "personal";
  const canManageProject = (p: Project) => !activeReadOnly && (isAdmin || p.ownerId === currentUserId || !p.ownerId);
  // a project's board settings (WIP limits, project covers): its writers — everyone here but guests (the projects policies)
  const canEditProjectBoard = (p: Project) => !activeReadOnly && !p.id.startsWith("tmp-");
  // where Plan's quick capture files a task (createFromPlan uses the same rule), so its preview agrees
  const planProjectId = wsProjects.find((p) => !p.id.startsWith("tmp-"))?.id ?? "p-personal";
  const askProjects = wsProjects.map((p) => ({ id: p.id, name: p.name }));
  const askKey = JSON.stringify([dayKey, currentUserId, assignees, askProjects]);
  if (askContextRef.current?.key !== askKey) askContextRef.current = { key: askKey, value: { today: dayKey, me: currentUserId, members: assignees, projects: askProjects } };
  const askContext = askContextRef.current.value;
  const wsRules = automationRules.filter((r) => wsProjects.some((p) => p.id === r.projectId));
  const wsForms = forms.filter((f) => wsProjects.some((p) => p.id === f.projectId));

  /* ---- Today ---- */
  // Momentum: today's work done ÷ today's work (done today, plus open and due today,
  // planned today or scheduled today), counted exactly as Today's brief and rail count it
  const { done: doneToday, total: dayTotal } = momentumCounts(myTasks, dayKey, currentUserId);
  const setup = [
    { label: "Add your first task", done: allTasks.length > 0, action: () => openNewTask() },
    { label: "Plan your day", done: myTasks.some((t) => t.scheduled != null || !!t.planToday), action: () => setRoute({ view: "plan" }) },
    { label: "Connect your calendar", done: calConnections.length > 0, action: () => openSettings("calendar") },
    { label: "Invite your team", done: workspaces.some((w) => w.id !== null), action: () => setRoute({ view: "team" }) },
  ];
  const startFocus = (taskId?: string) => { if (taskId) focusTask(taskId); else openFocus(true); };

  /* ---- a project's page ---- */
  const projUpdates = openProject ? statusUpdates.filter((u) => u.projectId === openProject.id) : [];
  const projRules = openProject ? automationRules.filter((r) => r.projectId === openProject.id) : [];
  const projForms = openProject ? forms.filter((f) => f.projectId === openProject.id) : [];
  // the tab in the address (a bare /p/:id is given the one it was last shown in); My tasks' view is its own
  const projectView: TaskView = isTaskView(route.tab) ? route.tab : openPrefs?.view ?? "list";
  const taskView: TaskView = openProject ? projectView : view;
  const projectTab = openProject ? route.tab ?? projectView : undefined;
  const goProjectTab = (tab: ProjectTab | string) => {
    if (!openProject) return;
    setRoute({ view: "project", projectId: openProject.id, tab }, { keepPanel: true });
  };
  const projectHref = (tab: string) => (openProject ? pathOf({ view: "project", projectId: openProject.id, tab }) : undefined);
  const extraTabs: TabItem[] = openProject ? [
    // 0047: the project's docs (guests read them too)
    { id: "docs", label: "Docs", secondary: true, href: projectHref("docs") },
    { id: "updates", label: "Updates", count: projUpdates.length || undefined, secondary: true, href: projectHref("updates") },
    { id: "requests", label: "Requests", count: projForms.length || undefined, secondary: true, href: projectHref("requests") },
    ...(activeReadOnly ? [] : [{ id: "rules", label: "Rules", count: projRules.length || undefined, secondary: true, href: projectHref("rules") }]),
    { id: "about", label: "About", secondary: true, href: projectHref("about") },
  ] : [];
  const rulesProps = (projectId?: string): React.ComponentProps<typeof AutomationsView> => ({
    rules: projectId ? wsRules.filter((r) => r.projectId === projectId) : wsRules, projects: wsProjects, members: assignees, sections, tags,
    onCreate: createRule, onUpdate: updateRule, onDelete: deleteRule, ...(projectId ? { projectId } : {}),
  });
  const formsProps = (projectId?: string): React.ComponentProps<typeof FormsView> => ({
    forms: projectId ? wsForms.filter((f) => f.projectId === projectId) : wsForms, projects: wsProjects, members: assignees,
    onCreate: createForm, onUpdate: updateForm, onDelete: deleteForm, onSubmit: submitForm, ...(projectId ? { projectId } : {}),
    // a form's public link was switched or regenerated: the panel has already saved it
    onPublicChange: (id, p) => setForms((fs) => fs.map((x) => (x.id === id ? { ...x, ...p } : x))),
  });
  const aiStatus = aiOn ? (facts: unknown) => store.aiStatus(facts) : undefined;
  const risksByProject: Record<string, number> = {};
  risks.forEach((r) => { if (r.projectId) risksByProject[r.projectId] = (risksByProject[r.projectId] ?? 0) + 1; });

  /* ---- the page header ---- */
  const tabItem = (t: PlaceTab, extra: Partial<TabItem> = {}): TabItem => ({ id: t.id, label: t.label, secondary: t.secondary, href: pathOf(t.route), ...extra });
  const placeTab = (tabs: PlaceTab[]) => (id: string) => { const t = tabs.find((x) => x.id === id); if (t) setRoute(t.route); };
  const place = placeOf(route);
  const header: Pick<PageHeaderProps, "title" | "meta" | "leading" | "titleAddon" | "switcher" | "actions" | "tabs" | "tabValue" | "onTab" | "tabsLabel" | "momentum" | "identity"> = (() => {
    switch (place) {
      case "today": {
        if (route.view === "home") {
          return { title: "Today", meta: dayMeta(KANBO_TODAY), actions: <Button variant="ghost" size="sm" icon="arrowLeft" onClick={() => setRoute({ view: "plan" })}>Back to Today</Button> };
        }
        const shutDown = shutdownDone(currentUserId, dayKey);
        return {
          title: "Today", meta: dayMeta(KANBO_TODAY),
          // 0048: your streak, beside the title (hidden in Settings, or from its own popover)
          titleAddon: route.view === "plan" && !onboarding.momentum?.streakHidden ? (
            <Suspense fallback={null}><TodayStreak currentUserId={currentUserId} tasks={myTasksEverywhere} prefs={onboarding.momentum} onChangePrefs={saveMomentum} /></Suspense>
          ) : undefined,
          // (a task held over Day or Week while dragging opens it: lib/dnd spring-loading)
          switcher: { items: tabsFor("today", navCtx).map((t) => ({ id: t.id, label: t.label, spring: t.id === "plan" || t.id === "myweek" })), value: route.view, onChange: (id) => setRoute({ view: id as Route["view"] }), label: "Show your day, week or month",
            onIntent: (id) => prefetchRoute({ view: id as Route["view"] }) },
          actions: activeReadOnly ? undefined
            : route.view === "plan" && lateDay
              ? <Button variant="secondary" size="sm" icon="sunset" iconRight={shutDown ? "check" : undefined} aria-label={shutDown ? "Shut down (done for today)" : "Shut down my day"} onClick={() => setShutdownOpen(true)}>Shut down</Button>
              : route.view === "myweek"
                ? <Button variant="secondary" size="sm" icon="check" onClick={() => setWeeklyOpen(true)}>Weekly review</Button>
                : undefined,
          momentum: route.view === "plan" && dayTotal > 0 ? doneToday / dayTotal : null,
        };
      }
      case "inbox": {
        return { title: "Inbox", meta: newCount > 0 ? `${newCount} new` : "Nothing new" };
      }
      case "tasks": {
        // a smart list or saved view names itself
        if (route.view === "search") return { title: "Search", meta: route.list ? SMART_LISTS.find((l) => l.id === route.list)?.label ?? searchView?.name : undefined };
        const open = myTasks.filter((t) => t.status !== "done" && !t.parentId).length;
        return { title: "My tasks", meta: `${activeWsName} · ${open} open` };
      }
      case "projects": {
        if (route.view === "project") {
          if (!openProject) return { title: "Project" };
          return {
            title: openProject.name,
            // its cover, and its tile (its emoji lives there, never beside the name as well)
            identity: { project: openProject, crumb: { label: "Projects", href: pathOf({ view: "projects" }), onClick: () => setRoute({ view: "projects" }) } },
            titleAddon: <Suspense fallback={null}><ProjectTitleAddon project={openProject} tasks={scoped} statusUpdates={projUpdates} onOpenUpdates={() => goProjectTab("updates")} /></Suspense>,
            actions: (
              <Suspense fallback={null}><ProjectActions project={openProject} tasks={scoped} statusUpdates={projUpdates} canManage={canManageProject(openProject)} readOnly={activeReadOnly}
                onPostStatus={activeReadOnly ? undefined : postStatusUpdate} aiStatus={aiStatus} onTab={goProjectTab}
                onDuplicate={activeReadOnly ? undefined : duplicateProject}
                onArchive={activeReadOnly || !canArchiveProject(openProject, { myRole }) ? undefined : (id) => setProjectArchived(id, true)}
                onDelete={activeReadOnly || openProject.id === "p-personal" || !canDeleteProject(openProject) ? undefined : (id) => setDeleteProjectId(id)}
                onEditIdentity={activeReadOnly ? undefined : (patch) => updateProject(openProject.id, patch)}
                onPlanTasks={activeReadOnly || openProject.id.startsWith("tmp-") ? undefined : () => openPlanner({ mode: "append", projectId: openProject.id })} /></Suspense>
            ),
          };
        }
        // 0047: Projects › Recycle bin (the page draws no title of its own)
        if (route.view === "bin") return { title: "Recycle bin", meta: activeWsName, actions: <Button variant="ghost" size="sm" icon="arrowLeft" onClick={() => setRoute({ view: "projects" })}>All projects</Button> };
        const tabs = tabsFor("projects", navCtx);
        const counts: Record<string, number> = { automations: wsRules.length, forms: wsForms.length };
        return {
          title: "Projects", meta: activeWsName,
          tabs: tabs.map((t) => tabItem(t, { count: counts[t.id] || undefined })), tabValue: route.view, onTab: placeTab(tabs), tabsLabel: "Projects",
          // (secondary: the header's New task is this row's one primary button)
          actions: activeReadOnly ? undefined : <Button variant="secondary" size="sm" icon="plus" onClick={() => setNewProjectOpen(true)}>New project</Button>,
        };
      }
      case "team": {
        // Personal has no team: Insights, and People / Workload (their empty states) by name when reached by address
        if (personal) return { title: titleOf(route, { personal }) };
        const tabs = tabsFor("team", navCtx);
        const people = assignees.length;
        return {
          title: "Team", meta: `${activeWsName} · ${people === 1 ? "1 person" : `${people} people`}`,
          tabs: tabs.map((t) => tabItem(t, t.id === "team" ? { count: people } : {})),
          tabValue: route.view === "reports" ? "analytics" : route.view, onTab: placeTab(tabs), tabsLabel: "Team",
        };
      }
    }
  })();
  const createMenu: PageHeaderProps["create"] = activeReadOnly ? null : {
    onNewTask: () => openNewTask(), onQuickCapture: openCapture, onFromTemplate: () => openTemplateLibrary(), onPasteNotes: () => openExtract(),
    onImport: () => openImport(), onNewProject: () => setNewProjectOpen(true),
  };

  // Insights (Overview and Trends): the scope lives here, so moving between them keeps it.
  // (No aiSummary: Trends asks Kanbo itself, with the scope and filters it's showing, and
  // follows "Use Kanbo AI".)
  const insightsNav = {
    scope: insightsScope, onScopeChange: setInsightsScope, currentUserId, personal, onAsk: () => openPalette(""),
    onOpenTrends: () => setRoute({ view: "reports" }), onOpenOverview: () => setRoute({ view: "analytics" }),
  } satisfies InsightsNavProps;
  // Settings › Workspace: the workspace's owner and admins (never a guest)
  const canWorkspaceSettings = workspace !== null && !activeReadOnly && (isAdmin || workspaces.find((w) => w.id === workspace)?.ownerId === currentUserId);
  const tagCounts: Record<string, number> = {};
  seen.forEach((t) => (t.tags || []).forEach((tg) => { tagCounts[tg] = (tagCounts[tg] || 0) + 1; }));
  // Inbox › Archived: what was archived this session, in this workspace, newest first
  // (a task's activity belongs to the workspace its task lives in, as in the Inbox itself)
  const wsTaskIds = new Set(tasks.filter((t) => (t.workspaceId ?? null) === workspace).map((t) => t.id));
  const inboxArchived = archivedRev >= 0 ? [...archivedHereRef.current.values()].map((p) => p.item)
    .filter((a) => (a.kind === "integration" && !a.taskId) || (!!a.taskId && wsTaskIds.has(a.taskId)) || (a.kind === "doc_mention" && docMentionInWorkspace(a, projects, workspace)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : [];
  // Workload and Radar: guests' work shows, but they carry no team capacity
  const loadMembers = assignees.map((a) => ({ ...a, guest: wsMembers.some((m) => m.userId === a.id && (m.workspaceId ?? null) === workspace && m.role === "guest") || undefined }));

  const renderMain = () => {
    switch (route.view) {
      // (the demo's Today keeps its illustrative day, already in the example calendars' colours)
      case "plan": return <TodayView tasks={myTasks} allTasks={allTasks} events={calEvents} calendarConnected={store.configured && calConnections.length > 0}
        currentUserId={currentUserId} userName={currentUser?.name} captureDefaults={{ projectId: planProjectId, assigneeId: currentUserId }}
        onUpdate={guardedPatch} onCreate={createFromPlan} onOpen={setDetailId} onRank={rankForToday} ranking={aiBusy}
        onStartFocus={startFocus} onShutdown={() => setShutdownOpen(true)} onExtractFromMeeting={(title) => openExtract(undefined, title)}
        onConnectCalendar={() => openSettings("calendar")} setup={setup} showSuggestions={appearance.suggestions !== false}
        riskCount={isAdmin ? signalRisks : undefined} onOpenRisks={isAdmin ? () => setRoute({ view: "pulse" }) : undefined} readOnly={activeReadOnly}
        members={assignees} projects={askProjects} onOpenMyTasks={() => setRoute({ view: "tasks" })}
        risks={risks} onAsk={() => openPalette()}
        dayClosed={shutdownDone(currentUserId, dayKey)} onPlanTomorrow={() => setRoute({ view: "myweek" })}
        // 0048: "Get set up" in place of the old "2 of 4 set up" chip, then the week's wins (Friday afternoons, Monday mornings)
        setupSlot={showSetup ? (
          <Suspense fallback={null}><SetupChecklist role={tourRole} onboarding={onboarding} signals={setupFacts} hidden={setupHidden} onChange={changeOnboarding} onAction={onSetupAction} /></Suspense>
        ) : null}
        winsSlot={onboarding.momentum?.recapHidden ? null : (
          <Suspense fallback={null}><TodayWins currentUserId={currentUserId} workspaceId={workspace} tasks={myTasksEverywhere} projects={projects} members={wsPeople}
            prefs={onboarding.momentum} onOpenTask={setDetailId} onHide={() => saveMomentum({ ...(onboarding.momentum ?? {}), recapHidden: true })} userName={currentUser?.name} /></Suspense>
        )} />;
      case "myweek": return <MyWeekView tasks={myTasks} onOpen={setDetailId} onPatch={guardedPatch} currentUserId={currentUserId} readOnly={activeReadOnly} />;
      // Overview (the classic Home) keeps the workspace's tasks for its project cards and "is this
      // workspace empty?" (a new member with nothing assigned yet isn't on a clean slate); its
      // personal widgets — today's brief, focus queue, weekly chart — use yours
      case "home": return <HomeView tasks={allTasks} myTasks={myTasks} projects={wsProjects} userName={currentUser?.name} onOpen={setDetailId} setRoute={setRoute} openFocus={() => openFocus(true)} onNewProject={() => setNewProjectOpen(true)} onNewTask={() => openNewTask()} onAutoPrioritize={autoPrioritize} aiBusy={aiBusy} calendarConnected={calConnections.length > 0} hasTeam={workspaces.some((w) => w.id !== null)} canCreateProject={!activeReadOnly} />;
      case "analytics": return <AnalyticsView key={wsKey} tasks={allTasks} members={assignees} customFields={customFields} projects={wsProjects} onOpen={setDetailId} {...insightsNav} />;
      case "reports": return <ReportsView key={wsKey} tasks={allTasks} projects={wsProjects} members={assignees} onOpen={setDetailId} {...insightsNav} />;
      // 0048 universal search: tasks, comments, docs, projects and people; saved as views (lib/views)
      case "search": return <SearchView tasks={seen} projects={projects} members={everyone} currentUserId={currentUserId} onOpen={setDetailId}
        savedSearches={NO_SAVED_SEARCHES} onSaveSearch={noop} onDeleteSavedSearch={noop}
        preset={searchPreset} presetKey={searchView ? searchView.id : searchPresetKey} presetView={searchView?.query}
        onBulkPatch={guardedBulkPatch} onBulkDelete={bulkDelete} sections={sections} customFields={customFields}
        onToggle={toggleTask} activeId={detailId ?? undefined}
        workspaceId={workspace} workspaces={workspaces} readOnly={activeReadOnly} onGo={(r) => setRoute(r)}
        onOpenProject={(id) => {
          const p = projects.find((x) => x.id === id);
          if (p && (p.workspaceId ?? null) !== workspace) setWorkspace(p.workspaceId ?? null);
          setRoute({ view: "project", projectId: id });
        }}
        onOpenDoc={(docId, projectId) => {
          const p = projects.find((x) => x.id === projectId);
          if (p && (p.workspaceId ?? null) !== workspace) setWorkspace(p.workspaceId ?? null);
          setRoute({ view: "project", projectId, tab: "docs", docId });
        }}
        onOpenPerson={() => setRoute({ view: "team" })}
        views={{ workspaceId: workspace, workspaceName: activeWsName, canShare: canShareViews(myRole ?? null, workspace) }} />;
      case "workload": return <WorkloadView tasks={allTasks} members={loadMembers} onOpen={setDetailId} personal={personal} onNewWorkspace={() => setNewWorkspaceOpen(true)} />;
      case "goals": return <GoalsView goals={goals.filter((g) => (g.workspaceId ?? null) === workspace)} projects={wsProjects} tasks={allTasks} onCreate={createGoal} onUpdate={updateGoal} onDelete={deleteGoal} />;
      case "portfolios": return <PortfoliosView portfolios={portfolios.filter((p) => (p.workspaceId ?? null) === workspace)} projects={wsProjects} tasks={allTasks} onCreate={createPortfolio} onUpdate={updatePortfolio} onDelete={deletePortfolio} onOpenProject={(pid) => setRoute({ view: "project", projectId: pid })} statusUpdates={statusUpdates} />;
      case "automations": return <AutomationsView key={wsKey} {...rulesProps()} readOnly={activeReadOnly} />;
      case "forms": return <FormsView key={wsKey} {...formsProps()} readOnly={activeReadOnly} />;
      // (your own plan on each task: "Add to Today" knows what's already on your day)
      case "inbox": return <InboxView activity={scopedActivity} tasks={allSeen} onOpen={setDetailId} onArchive={archiveActivity} onClearAll={clearInbox} onNewCount={setInboxLiveNew}
        currentUserId={currentUserId} members={assignees} readOnly={activeReadOnly} archived={inboxArchived} onUnarchive={unarchiveInbox}
        // a reply to someone mentions them, so they hear about it
        onReply={(taskId, body, mentions) => addComment(taskId, body, mentions ?? [])}
        onAcceptToday={(taskId) => guardedPatch(taskId, { planToday: true })}
        onSchedule={(taskId, dueDate) => guardedPatch(taskId, { dueDate })}
        onComplete={(taskId) => { if (tasksRef.current?.find((t) => t.id === taskId)?.status !== "done") toggleTask(taskId); }}
        // "Webhook to … switched off" opens Settings › Developers, where it's switched back on
        // (hidden while you're a guest here: the notice says where to go)
        onOpenIntegration={activeReadOnly ? undefined : () => openSettings("developers")}
        // 0047: "Approvals for you" first (this workspace's), and doc @mentions open their doc
        approvals={{ toReview: approvalsInWorkspace(myApprovals.toReview, workspace), projects, members: wsPeople, onDecided: onApprovalsChange }}
        onOpenDoc={(a) => { const r = docMentionRoute(a); if (r) setRoute(r); }}
        // 0048: bundles and the quiet-hours line follow your prefs ("Change" opens them); snoozes look after themselves
        notifyPrefs={profile?.notifyPrefs} onOpenNotificationSettings={() => openSettings("notifications")} />;
      // Month: yours by default, the whole workspace's on "Team". Calendars are connected in Settings.
      case "calendar": return <CalendarView tasks={calScope === "team" ? allTasks : myTasks} onOpen={setDetailId} onPatch={guardedPatch} connections={calConnections} externalEvents={calEvents} warnings={calWarnings} syncing={calSyncing} readOnly={activeReadOnly}
        scope={calScope} onScopeChange={setCalScope} onOpenSettings={() => openSettings("calendar")} />;
      case "projects": return <ProjectsView projects={wsProjects} tasks={allTasks} statusUpdates={statusUpdates} members={assignees} currentUserId={currentUserId}
        canCreate={!activeReadOnly} onOpenProject={(pid) => setRoute({ view: "project", projectId: pid })} onNewProject={() => setNewProjectOpen(true)}
        onPlanProject={activeReadOnly ? undefined : () => openPlanner({ mode: "new" })}
        onPostUpdate={activeReadOnly ? undefined : postStatusUpdate} aiStatus={aiStatus} risksByProject={risksByProject} />;
      // 0047: deleted tasks and projects, 30 days (rows come back through the realtime reload too)
      case "bin": return (
        <RecycleBin key={wsKey} workspaceId={workspace} workspaceName={activeWsName} role={workspace ? (myRole ?? null) : null} currentUserId={currentUserId}
          members={wsPeople} projects={wsProjects} onRestored={(rs) => clearWrite(rs.map((r) => r.itemId))}
          onOpenProject={(id) => setRoute({ view: "project", projectId: id })} />
      );
      case "pulse": return <TeamPulse tasks={allTasks} members={wsMembers.filter((m) => m.workspaceId === workspace)} currentUserId={currentUserId} workspaceName={activeWsName} workspaceId={workspace} readOnly={activeReadOnly}
        loadEvents={(since) => store.listWorkspaceEventsSince(workspace, since)} onOpen={setDetailId}
        onNudge={async (taskId, userId, text) => { await addComment(taskId, text, [userId]); }} onPatch={guardedPatch} onOpenWorkload={() => setRoute({ view: "workload" })}
        onWriteUp={aiOn ? (facts) => store.aiStandup(facts) : undefined}
        personal={personal} onNewWorkspace={() => setNewWorkspaceOpen(true)} onOpenPeople={() => setRoute({ view: "team" })}
        // 0048: a task dropped on a person is handed to them (Undo); kudos read live
        onDropTasksOnPerson={activeReadOnly ? undefined : dropOnPerson} />;
      // (the workspace's logo, name and Close workspace live in Settings › Workspace)
      case "team": return <TeamView tasks={allTasks} workspace={workspace} workspaces={workspaces} members={wsMembers} currentUserId={currentUserId} myRole={myRole} onInvite={inviteMember} onResendInvite={store.configured ? resendInvite : undefined} onRemoveMember={removeMember} onSetRole={setMemberRole} onSetTitle={setMemberTitle} onTransferOwnership={transferOwnership} onOpen={setDetailId} onNewWorkspace={() => setNewWorkspaceOpen(true)}
        onOpenWorkspaceSettings={canWorkspaceSettings ? () => openSettings("workspace") : undefined}
        onDropTasksOnPerson={activeReadOnly ? undefined : dropOnPerson} />;
      case "tasks":
      case "project": {
        const inProject = !!openProject;
        // (keyed by the saved view too, and by whether it has loaded: arriving on one starts the page from it)
        const viewKey = `${route.savedViewId ?? ""}:${viewStart ? 1 : 0}`;
        const viewGroupBy = appliedView && viewGroup?.viewId === appliedView.id ? viewGroup.groupBy
          : viewStart?.listGroup && isGroupBy(viewStart.listGroup) ? viewStart.listGroup : undefined;
        return <TasksPage key={`${route.view}:${route.projectId ?? ""}:${wsKey}:${viewKey}`} filterScope={openProject ? openProject.id : "my"} readOnly={activeReadOnly}
          boardScope={openProject ? `project:${openProject.id}` : `my:${wsKey}`}
          exportName={openProject ? openProject.name : "my-tasks"}
          tasks={scoped} allTasks={allTasks} projects={wsProjects} view={taskView} setView={inProject ? goProjectTab : setView}
          groupBy={inProject ? viewGroupBy ?? openPrefs?.groupBy ?? "status" : groupBy}
          setGroupBy={inProject ? (g: GroupBy) => { if (appliedView) setViewGroup({ viewId: appliedView.id, groupBy: g }); else saveProjectPrefs(openProject.id, { groupBy: g }); } : setGroupBy} smart={smart} setSmart={setSmart} onOpen={setDetailId} onToggle={toggleTask} onToggleSubtask={toggleSubtask} onAdd={openNewTask} onMove={(id, status, position) => {
            // a reorder within the same column is not a status change (completedAt stays put)
            const prev = tasksRef.current?.find((t) => t.id === id);
            const patch: Partial<Task> = {};
            if (prev && prev.status !== status) patch.status = status;
            if (position !== undefined) patch.position = position;
            if (Object.keys(patch).length) guardedPatch(id, patch);
          }} onBulkPatch={guardedBulkPatch} onBulkDelete={bulkDelete} onPatch={guardedPatch} onQuickAdd={quickAddTask} onOpenImport={activeReadOnly ? undefined : () => openImport()} members={assignees} allTags={tags}
          archivedTasks={archivedTasks}
          sections={route.view === "tasks" ? sections.filter((s) => s.projectId === "__my") : (openProject ? sections.filter((s) => s.projectId === openProject.id) : sections)}
          onCreateSection={createSection} onRenameSection={renameSection} onDeleteSection={deleteSection}
          sectionField={route.view === "tasks" ? "mySectionId" : "sectionId"}
          sectionProjectId={route.view === "tasks" ? "__my" : route.projectId}
          customFields={openProject ? customFields.filter((f) => f.projectId === openProject.id) : customFields}
          exportOpts={{ sections, customFields: openProject ? customFields.filter((f) => f.projectId === openProject.id) : customFields, allTasks }}
          currentUserId={currentUserId}
          // rows follow Appearance's density (the Display menu changes it there), and the open task stays marked
          density={appearance.density} onDensity={(density) => setAppearance((a) => ({ ...a, density }))} activeTaskId={detailId ?? undefined}
          // 0048: a saved view's start, Save view, the single Delete
          viewStart={viewStart} onDeleteTask={deleteTask}
          views={{ workspaceId: workspace, workspaceName: activeWsName, canShare: canShareViews(myRole ?? null, workspace), appliedView: appliedView ?? null, role: myRole ?? null }}
          {...(inProject ? {
            // a project: its views as tabs, then Updates · Requests · Rules · About, and its notice line
            tab: projectTab, onTab: goProjectTab, extraTabs,
            renderExtra: (tab: string) => tab === "docs" ? (
              <Suspense fallback={null}>
                <DocsTab project={openProject!} members={wsPeople} tasks={scoped} currentUserId={currentUserId} readOnly={activeReadOnly}
                  docId={route.docId ?? null}
                  onOpenDoc={(docId) => setRoute({ view: "project", projectId: openProject!.id, tab: "docs", ...(docId ? { docId } : {}) }, { keepPanel: true })}
                  onMakeTask={makeDocTask} onOpenTask={setDetailId} />
              </Suspense>
            ) : (
              <Suspense fallback={null}><ProjectPanels tab={tab as "updates" | "requests" | "rules" | "about"} project={openProject!} tasks={scoped} statusUpdates={projUpdates} members={assignees}
                canManage={canManageProject(openProject!)} readOnly={activeReadOnly} onUpdate={(id, patch) => updateProject(id, patch as Parameters<typeof updateProject>[1])}
                onPostStatus={activeReadOnly ? undefined : postStatusUpdate} aiStatus={aiStatus}
                rules={{ ...rulesProps(openProject!.id), readOnly: activeReadOnly }} forms={{ ...formsProps(openProject!.id), readOnly: activeReadOnly }} /></Suspense>
            ),
            notice: <Suspense fallback={null}><ProjectNotice project={openProject!} statusUpdates={projUpdates} risks={risks.filter((r) => r.projectId === openProject!.id)} onOpenUpdates={() => goProjectTab("updates")} onOpenRisks={() => setRoute({ view: "pulse" })} /></Suspense>,
            // 0048 board: the project's settings ({} when none: its WIP limits are then everyone's); writers save one change at a time
            boardSettings: openProject!.boardSettings ?? {},
            onChangeBoardSettings: canEditProjectBoard(openProject!) ? (next: BoardSettings, change: BoardSettingsChange) => updateProject(openProject!.id, { boardSettings: next, boardSettingsChange: change }) : undefined,
          } satisfies Partial<React.ComponentProps<typeof TasksPage>> : {
            // My tasks: Open · Waiting on · Done, due-date anchors, saved views
            tab: route.tab ?? "open", onTab: (id: string) => setRoute({ view: "tasks", tab: id === "open" ? undefined : id }, { keepPanel: true }),
            dueFocus: isDueFocus(route.list) ? route.list : viewStart?.dueFocus,
            // 0048: the pinned views (not project ones) as links beside the tabs; "mine" is the smart list
            savedViews: sv.pinned.filter((v) => v.kind !== "project").map((v) => ({ id: v.id, name: v.name, count: savedViewCounts[v.id] ?? 0 })),
            onOpenSavedView: (id: string) => { const v = getSavedView(id); setRoute(v ? viewRoute(v) : { view: "search", list: id }); },
            onNudge: nudge, onAdvancedSearch: () => setRoute({ view: "search" }), onManageTags: () => openSettings("tags"),
            // 0047: Waiting on › "Waiting on approval" (your open requests)
            waitingApproval: waitingOnApproval(myApprovals, allTasks),
          } satisfies Partial<React.ComponentProps<typeof TasksPage>>)} />;
      }
      default: return null;
    }
  };

  // App keeps the open project valid (its route guard), so the Sidebar's own guard stays off
  const sidebar = (
    <Sidebar route={route} setRoute={setRoute} workspace={workspace} setWorkspace={switchWorkspace} workspaces={workspaces} onNewWorkspace={() => setNewWorkspaceOpen(true)} focus={focus} openFocus={openFocus} tasks={allTasks} projects={projects} inboxCount={newCount}
      currentUserId={currentUserId} currentUser={currentUser} onSignOut={auth.configured ? auth.signOut : undefined} onOpenSettings={() => openSettings()} onNewProject={() => setNewProjectOpen(true)} onDeleteProject={(id) => setDeleteProjectId(id)} onArchiveProject={(id) => setProjectArchived(id, true)} onRestoreProject={(id) => setProjectArchived(id, false)}
      subscription={subscription} onUpgrade={() => setUpgradeOpen(true)} onManageBilling={manageBilling}
      // 0048: the Views group (pinned saved views, live counts); tasks dropped on a project row move there, on Today plan it
      views={sv.views} viewCounts={savedViewCounts}
      onDropTasksOnProject={activeReadOnly ? undefined : dropOnProject} onDropTasksOnToday={activeReadOnly ? undefined : dropOnToday}
      help={(
        <Suspense fallback={null}>
          <HelpMenu onStartTour={() => startTourNow()} onOpenShortcuts={() => openSettings("shortcuts")}
            // guests can't make projects; the sample lives in Personal
            sample={activeReadOnly && workspace !== null ? null : { exists: !!onboarding.sample, busy: sampleBusy, onCreate: trySample, onRemove: removeSample }}
            setup={setupDismissedEarly ? { ...setupProgress, onShow: () => { changeOnboarding(dismissSetupChecklist(onboarding, false)); setRoute({ view: "plan" }); } } : null} />
        </Suspense>
      )}
      myRole={myRole} guardRoute={false}
      theme={resolvedTheme} onToggleTheme={flipTheme} teamBadge={!personal && signalRisks > 0 ? signalRisks : undefined}
      onOpenSearch={() => openPalette()} onOpenShortcuts={() => openSettings("shortcuts")} />
  );

  return (
    // Desktop: the sidebar and a main column whose views scroll on their own. Phone: the
    // whole page is one scroll (the header and the bottom bar stay put), no inner scroll boxes.
    <div ref={rootRef} data-panel={detailId ? "open" : undefined} onPointerOver={prefetchLink} onFocus={prefetchLink} style={isMobile
      ? { position: "relative", height: "100vh", overflowX: "hidden", overflowY: "auto", overscrollBehaviorY: "contain", background: "var(--bg)" }
      : { position: "relative", height: "100vh", display: "flex", overflow: "hidden", background: "var(--bg)" }}>
      <AppBg />
      <GlobalTipStyles />
      <div className="sr-only" aria-live="polite" aria-atomic="true">{announced}</div>
      {isMobile ? (
        <>
          {sidebarOpen && <div aria-hidden="true" onClick={() => setSidebarOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 49, background: "var(--scrim, color-mix(in oklch, var(--bg-deep) 55%, transparent))", animation: "fadeIn var(--d-2, 160ms) var(--ease)" }} />}
          <div ref={drawerRef} role="dialog" aria-modal={sidebarOpen ? true : undefined} aria-label="Menu" aria-hidden={sidebarOpen ? undefined : true} style={{ position: "fixed", top: 0, left: 0, bottom: 0, zIndex: 50, display: "flex", transform: sidebarOpen ? "none" : "translateX(-100%)", boxShadow: sidebarOpen ? "var(--e3, var(--shadow-lg))" : "none",
            // hidden (not just off-screen) once the slide-out finishes, so nothing in it can be reached
            visibility: sidebarOpen ? "visible" : "hidden", transition: sidebarOpen ? "transform var(--d-3, 240ms) var(--ease), visibility 0s" : "transform var(--d-3, 240ms) var(--ease-exit, var(--ease)), visibility 0s linear var(--d-3, 240ms)" }}>
            {sidebar}
          </div>
        </>
      ) : sidebar}
      <main id="main" tabIndex={-1} style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", position: "relative", zIndex: 1, outline: "none", ...(isMobile ? { minHeight: "100%" } : {}) }}>
        {!online && (
          <Notice tone="warn" icon="refresh">
            You're offline — changes are saved on this device{pendingSync > 0 ? ` (${pendingSync} queued)` : ""} and will sync when you reconnect.
          </Notice>
        )}
        {online && (syncing || pendingSync > 0) && (
          <Notice tone="accent" icon="refresh" spin={syncing}
            actions={!syncing && <Button variant="ghost" size="sm" onClick={flushOffline}>Retry now</Button>}>
            {syncing ? `Syncing ${pendingSync || ""} offline change${pendingSync === 1 ? "" : "s"}…` : `${plural(pendingSync, "change")} waiting to sync`}
          </Notice>
        )}
        {deadLetters.length > 0 && (
          <Notice tone="signal" icon="refresh" actions={<>
            <Button variant="ghost" size="sm" onClick={retryDeadLetters} disabled={!online || syncing}>Retry</Button>
            <Button variant="ghost" size="sm" onClick={discardDeadLetters}>Discard</Button>
          </>}>
            {/* retryable: a server problem that may clear up; otherwise the server refused the change itself (e.g. no permission) */}
            {plural(deadLetters.length, "change")} couldn't be synced{deadLetters.every((d) => !d.retryable) ? ` — the server turned ${deadLetters.length === 1 ? "it" : "them"} down` : ""}. {deadLetters.length === 1 ? "It's" : "They're"} kept on this device.
          </Notice>
        )}
        {unsavedIds.length > 0 && (
          <Notice tone="signal" icon="refresh" actions={<>
            <Button variant="ghost" size="sm" onClick={retryUnsaved}>Retry</Button>
            <Button variant="ghost" size="sm" onClick={discardUnsaved}>Discard</Button>
          </>}>
            {plural(unsavedIds.length, "task")} couldn't be saved — {unsavedIds.length === 1 ? "it's" : "they're"} only on this screen for now.
          </Notice>
        )}
        {activeReadOnly && (
          <Notice tone="neutral" icon="lock" role="note">
            You're a guest in {activeWsName} — you can view and comment. Ask a workspace admin for member access to edit.
          </Notice>
        )}
        {banner && banner.id !== bannerDismissed && (
          <Notice tone={banner.kind === "warning" ? "warn" : banner.kind === "success" ? "ok" : "accent"} icon="bell"
            actions={<IconButton icon="x" label="Dismiss announcement" size="sm" onClick={() => { setBannerDismissed(banner.id); try { localStorage.setItem("kanbo-banner-dismissed", banner.id); } catch { /* ignore */ } }} />}>
            {banner.message}
          </Notice>
        )}
        {BILLING_ENABLED && subscription?.status === "trialing" && <Suspense fallback={null}><TrialBanner sub={subscription} onUpgrade={() => setUpgradeOpen(true)} /></Suspense>}
        <PageHeader {...header} onSearch={() => openPalette()} create={createMenu} isMobile={isMobile} onOpenSettings={() => openSettings("profile")} userId={currentUserId}
          momentumLabel={header.momentum != null ? `Today's work done, ${doneToday} of ${dayTotal}` : undefined} />
        {/* the page fades in on a change of place (not of tab) */}
        <div key={place} className="kroute" style={{ flex: isMobile ? "1 0 auto" : 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          {/* a page that fails offers Today, and Today itself offers My tasks (never the page that just failed) */}
          <ErrorBoundary key={`${route.view}:${route.projectId ?? ""}`} inline name="view"
            onHome={() => setRoute(route.view === "plan" ? { view: "tasks" } : { view: "plan" })} homeLabel={route.view === "plan" ? "Go to My tasks" : "Go to Today"}>
            {/* 0047: every row and card reads its approval chip from here */}
            <ApprovalSummariesProvider summaries={approvalSummaries}>
              <Suspense fallback={<PlaceSkeleton kind={skeletonFor(route, taskView)} label={pageTitle} />}>
                <RenderView render={renderMain} />
              </Suspense>
            </ApprovalSummariesProvider>
          </ErrorBoundary>
        </div>
        {isMobile && (
          <div style={{ position: "sticky", bottom: 0, zIndex: "var(--z-header, 10)" }}>
            <MobileNav route={route} setRoute={setRoute} inboxCount={newCount} personal={personal}
              onCapture={activeReadOnly ? undefined : openCapture} onQuickAdd={activeReadOnly ? undefined : openQuickAdd} onQuickAddIntent={prefetchQuickAdd}
              onMore={() => setSidebarOpen(true)} moreOpen={sidebarOpen} />
          </div>
        )}
      </main>

      <Deferred when={importOpen}><ImportTasksModal open={importOpen} onClose={() => { setImportOpen(false); setImportText(undefined); }} initialText={importText}
        projects={wsProjects} members={assignees.map((a) => ({ ...a, email: wsMembers.find((m) => m.userId === a.id)?.email }))}
        sections={sections.filter((s) => !s.id.startsWith("tmp-") && wsProjects.some((p) => p.id === s.projectId))}
        defaultProjectId={openProject?.id}
        defaultProjectName={openProject?.name}
        supports={{ details: true, subtasks: true, newTags: true, newSections: true }}
        onImport={importTasks} /></Deferred>

      {/* tasks and projects from every workspace (like Search); opening a project elsewhere switches to its workspace */}
      <Deferred when={cmdOpen}><CommandPalette open={cmdOpen} onClose={() => setCmdOpen(false)} tasks={seen} onOpenTask={setDetailId}
        projects={projects} workspaces={workspaces} canCreateProject={!activeReadOnly}
        onOpenProject={(id) => {
          const p = projects.find((x) => x.id === id);
          if (p && (p.workspaceId ?? null) !== workspace) setWorkspace(p.workspaceId ?? null);
          setRoute({ view: "project", projectId: id });
        }}
        onSearchAll={(text) => { setRoute({ view: "search" }); setSearchPrefill({ text, key: "q-" + Date.now() }); }}
        onAction={(s) => {
          if (s.id === "new-task") openNewTask();
          else if (s.id === "quick-capture") openCapture();
          else if (s.id === "paste-notes") openExtract();
          else if (s.id === "import") openImport();
          else if (s.id === "new-project") setNewProjectOpen(true);
          else if (s.id === "plan-project") openPlanner({ mode: "new" });
          else if (s.id === "plan") setRoute({ view: "plan" });
          else if (s.id === "prioritize") autoPrioritize();
          else if (s.id === "focus") openFocus(true);
          else if (s.id === "shutdown") { if (!denyGuest([workspace])) setShutdownOpen(true); }
          else if (s.id === "weekly-review") { if (!denyGuest([workspace])) setWeeklyOpen(true); }
          else if (s.id === "board") { setRoute({ view: "tasks" }); setView("board"); }
          else if (s.id === "manage-tags") openSettings("tags");
          else if (s.id === "toggle-theme") flipTheme();
          else if (s.id === "shortcuts") openSettings("shortcuts");
          else if (s.id === "settings") openSettings();
        }} onNavigate={(v) => setRoute({ view: v as Route["view"] })}
        ai={aiOn ? (q, ts, ctx) => store.aiCommand(q, ts, ctx) : undefined}
        askContext={askContext} canAct={!activeReadOnly} onApplyAsk={applyAskActions} onGo={(r) => setRoute(r)}
        recent={recentRoutesRef.current.filter((r) => !sameRoute(r, route))} recentTaskIds={recentTaskIdsRef.current}
        // opened by an "Ask Kanbo" button: the example questions lead
        initialQuery={paletteQuery} askFirst={paletteQuery !== undefined} personal={personal} /></Deferred>

      {detailId && (
        <ErrorBoundary key={detailId} inline floating name="task-panel" onHome={() => setDetailId(null)} homeLabel="Close">
          <Suspense fallback={<PanelSkeleton mobile={isMobile} />}>
          <TaskDetail taskId={detailId} ai={aiOn} onApprovalsChange={onApprovalsChange} tasks={seen} tags={tags} activity={activity} members={wsMembers} currentUserId={currentUserId} onClose={() => setDetailId(null)} onOpenTask={setDetailId} projects={projects} onToggle={toggleTask} onPatch={guardedPatch} onDelete={deleteTask} onDuplicate={duplicateTask} onArchive={archiveTask} onUnarchive={unarchiveTask} onToggleSubtask={toggleSubtask} onAddSubtask={addSubtask} onCreateTag={createTag} onDeleteTag={deleteTag} onAddComment={addComment} onFocus={focusTask} onAddDependency={addDependency} onRemoveDependency={removeDependency} onToggleFollow={toggleFollow} onToggleTaskReaction={toggleTaskReaction} onToggleCollaborator={toggleCollaborator} customFields={customFields.filter((f) => f.projectId === detailTask?.projectId)} onCreateCustomField={createCustomField} onDeleteCustomField={deleteCustomField} sections={sections.filter((s) => s.projectId === detailTask?.projectId)} onCreateSection={createSection} onConvertComment={(body, pid) => { quickAddTask({ title: body.slice(0, 200), projectId: pid }); toastSuccess("Comment added as a task"); }}
            readOnly={detailReadOnly} docked={docked && !isMobile} onStartFocus={focusTask} onOpenProject={(pid) => setRoute({ view: "project", projectId: pid })}
            onSaveAsTemplate={(id) => setSaveTemplateFor(id)} />
          </Suspense>
        </ErrorBoundary>
      )}
      {/* suggestions are yours; the task you chose to focus on (anyone's) is always included */}
      {focusOpen && <Suspense fallback={null}><FocusMode focus={focus} tasks={focus.taskId && !myTasks.some((t) => t.id === focus.taskId) ? [...myTasks, ...seen.filter((t) => t.id === focus.taskId)] : myTasks} onClose={() => setFocusOpen(false)} onOpenTask={(id) => { setFocusOpen(false); setDetailId(id); }} /></Suspense>}
      <Deferred when={newTaskOpen}><NewTaskModal open={newTaskOpen} onClose={() => { setNewTaskOpen(false); setNewTaskTemplate(null); }} onCreate={createTask} onCreateTag={createTag} onDeleteTag={deleteTag} projects={wsProjects} allTags={tags} members={wsMembers} currentUserId={currentUserId} defaultStatus={newTaskStatus} defaultProjectId={newTaskProjectId}
        tagUsage={(id) => seen.filter((t) => t.tags.includes(id)).length}
        // 0048 templates: "/" or Template ▾ in the form, the library's "Use template", the whole plan through App's create paths
        workspaceId={workspace} initialTemplate={newTaskTemplate} onApplyTemplate={applyTemplatePlan}
        onBrowseTemplates={() => { setNewTaskOpen(false); setNewTaskTemplate(null); openTemplateLibrary(); }} /></Deferred>
      <Deferred when={newProjectOpen}><NewProjectModal open={newProjectOpen} onClose={() => setNewProjectOpen(false)} onCreate={createProject} workspaceId={workspace} projects={wsProjects}
        // guests never create from a template (createFromTeamTemplate refuses them too)
        onApplyTemplate={activeReadOnly ? undefined : createFromTeamTemplate}
        onPlanWithKanbo={activeReadOnly ? undefined : (typed) => openPlanner({ mode: "new", goal: typed || undefined })} /></Deferred>
      {/* one first-run dialog at a time: the name step (Welcome) first, then the tour */}
      {/* (tourAvailable: the TourHost below is mounted when a tour is asked for, so the sheet hands over to it) */}
      <Deferred when={onboardOpen && !welcomeOpen}><OnboardingModal open={onboardOpen && !welcomeOpen} profile={profile} workspaceId={workspace} onSaveProfile={saveProfile} onCreateProject={createProject} onFinish={finishOnboarding}
        onGoToday={() => setRoute({ view: "plan" })} tourAvailable /></Deferred>
      <Deferred when={newWorkspaceOpen}><NewWorkspaceModal open={newWorkspaceOpen} onClose={() => setNewWorkspaceOpen(false)} onCreate={createWorkspace} /></Deferred>
      {/* 0047: plan a project with Kanbo (loaded the first time it's opened) */}
      {planner && (() => {
        const planProject = planner.mode === "append" ? projects.find((p) => p.id === planner.projectId) ?? null : null;
        const planWs = planProject ? planProject.workspaceId ?? null : workspace;
        return (
          <ErrorBoundary inline floating name="planner" onHome={() => setPlanner(null)} homeLabel="Close">
            <Suspense fallback={null}>
              <PlannerHost open mode={planProject ? "append" : "new"} workspaceId={planWs}
                workspaceName={workspaces.find((w) => w.id === planWs)?.name || "Personal"}
                project={planProject} sections={planProject ? sections.filter((x) => x.projectId === planProject.id) : []}
                wsMembers={wsMembers} tasks={allTasks} currentUserId={currentUserId}
                // demo mode says "demo mode" rather than "Kanbo AI isn't available"
                aiEnabled={aiOn && store.configured} initialGoal={planner.goal} store={store}
                onClose={() => setPlanner(null)} onCreated={onPlanCreated} />
            </Suspense>
          </ErrorBoundary>
        );
      })()}
      <Deferred when={welcomeOpen}><WelcomeModal open={welcomeOpen} onClose={dismissWelcome}
        canSkip={!!((profile?.firstName?.trim()) || (profile?.lastName?.trim()))}
        onSaveProfile={(firstName, lastName) => saveProfile({ firstName, lastName, pronouns: profile?.pronouns ?? "" })}
        name={currentUser?.name && !currentUser.name.includes("@") ? currentUser.name : undefined}
        initialFirst={profile?.firstName ?? ""} initialLast={profile?.lastName ?? ""}
        // a new account the first-run sheet won't follow is offered the tour here
        tourAvailable offerTour={isNewAccount && !onboardOpen && !onboarding.tour?.done && !onboarding.tour?.skipped} /></Deferred>
      <Deferred when={settingsOpen}><SettingsModal open={settingsOpen} onClose={closeSettings}
        initial={{ firstName: profile?.firstName ?? "", lastName: profile?.lastName ?? "", pronouns: profile?.pronouns ?? "", avatarUrl: profile?.avatarUrl ?? null }}
        email={auth.user?.email ?? currentUser?.email ?? ""} color={currentUser?.color ?? SELF_COLOR}
        onUpload={uploadAvatar} onSave={saveProfile} onExport={exportData} onDeleteAccount={deleteAccount}
        notifyPrefs={profile?.notifyPrefs ?? {}} onSaveNotifyPrefs={saveNotifyPrefs} onNotifyPrefsStored={notifyPrefsStored}
        momentum={{ prefs: onboarding.momentum, onChange: saveMomentum }}
        appearance={appearance} onChangeAppearance={setAppearance}
        theme={theme} onChangeTheme={setTheme}
        section={settingsSection} onSection={setSettingsSection} isAdmin={canWorkspaceSettings} isGuest={activeReadOnly}
        renderWorkspace={canWorkspaceSettings ? () => (
          <>
            <WorkspaceSettingsPanel workspace={workspace} workspaces={workspaces} myRole={myRole} currentUserId={currentUserId}
              onUpdateWorkspace={updateWorkspace} onUploadLogo={uploadWorkspaceLogo} onDeleteWorkspace={deleteWorkspace} onNewWorkspace={() => setNewWorkspaceOpen(true)} />
            {/* 0047: Settings › Workspace › History (who did what here; owners and admins see everyone's) */}
            {workspace && (
              <Suspense fallback={null}>
                <HistoryLog workspaceId={workspace} workspaceName={activeWsName} members={wsPeople} currentUserId={currentUserId} canSeeAll={myRole === "owner" || myRole === "admin"} />
              </Suspense>
            )}
          </>
        ) : undefined}
        onGoPeople={workspace !== null ? () => setRoute({ view: "team" }) : undefined}
        tagsPanel={{ tags, taskCounts: tagCounts, onUpdate: updateTag, onDelete: deleteTag, onMerge: mergeTags, onCreate: createTag }}
        calendar={{
          connections: calConnections, syncing: calSyncing, warnings: calWarnings,
          onConnect: (provider) => { void connectCalendar(provider); },
          onDisconnect: (connectionId) => { void disconnectCalendar(connectionId); },
          loadCalendars: (connectionId) => store.listAccountCalendars(connectionId),
          onSelect: selectCalendars,
        }}
        // Slack for the active team workspace: owners/admins manage it, everyone sees if it's connected
        slack={{ workspaceId: workspace, workspaceName: activeWsName, role: myRole ?? null }}
        // Notion sits under Slack for the same workspace; imports land in its projects (archived ones keep their names in sync rows)
        notion={{ projects: projects.filter((p) => (p.workspaceId ?? null) === workspace), onOpenProject: (pid) => setRoute({ view: "project", projectId: pid }) }}
        // Settings › Developers: every team workspace you're in, with your role (guests too: the panels explain)
        developers={{ workspaces: workspaces.filter((w) => w.id && roleIn(w.id)).map((w) => ({ id: w.id!, name: w.name, role: roleIn(w.id)! })), currentWorkspaceId: workspace }}
        billing={{ enabled: BILLING_ENABLED, subscription, onUpgrade: () => setUpgradeOpen(true), onManageBilling: manageBilling }}
        // (Settings closes itself first, so the import dialog isn't underneath)
        onImport={activeReadOnly ? undefined : () => openImport()} /></Deferred>
      <Deferred when={quickCaptureOpen}><QuickCapture open={quickCaptureOpen} onClose={() => setQuickCaptureOpen(false)} projects={wsProjects} members={assignees}
        defaultProjectId={routeRef.current.view === "project" ? routeRef.current.projectId : undefined} onCreate={quickAddTask} tags={tags}
        onPasteNotes={(text) => openExtract(text)} onImportRows={(rows) => importTasks(rows)}
        // 0048: "/" picks a template; its whole plan goes through App's create paths
        onApplyTemplate={applyTemplatePlan} currentUserId={currentUserId}
        // a paste longer than Quick capture takes goes to Import tasks, with the text in
        onOpenImport={(text) => { setQuickCaptureOpen(false); openImport(text); }} /></Deferred>
      {/* 0048 phone: the phone bar's + (live NL highlighting, recent projects); the same create path as Quick capture */}
      <Deferred when={quickAddOpen}><QuickAddSheet open={quickAddOpen} onClose={() => setQuickAddOpen(false)} projects={wsProjects} members={assignees} currentUserId={currentUserId}
        defaultProjectId={routeRef.current.view === "project" ? routeRef.current.projectId : undefined}
        recentProjectIds={quickAddOpen ? recentProjectIds(tasks, { userId: currentUserId, projects: wsProjects.map((p) => ({ id: p.id, archivedAt: p.archivedAt ?? undefined })) }) : undefined}
        onCreate={quickAddTask} /></Deferred>
      {/* 0048 templates: the library (New task ▾ › From a template…), and Save as template (the task panel's ⋯) */}
      <Deferred when={templateLibrary.open}><TemplateLibrary open={templateLibrary.open} onClose={() => setTemplateLibrary({ open: false })} initialTemplateId={templateLibrary.initialTemplateId}
        workspaceId={workspace} workspaceName={activeWsName} currentUserId={currentUserId} canShare={canShareViews(myRole ?? null, workspace)}
        canManageShared={isAdmin} canApply={!activeReadOnly} onApply={applyLibraryTemplate} members={assignees} tags={tags} /></Deferred>
      {saveTemplateFor && (() => {
        const t = seen.find((x) => x.id === saveTemplateFor);
        if (!t) return null;
        const tWs = t.workspaceId ?? null;
        return (
          <Suspense fallback={null}>
            <SaveAsTemplate open task={t} subtasks={seen.filter((x) => x.parentId === t.id)} workspaceId={tWs}
              workspaceName={workspaces.find((w) => w.id === tWs)?.name || "Personal"} canShare={canShareViews(roleIn(tWs), tWs)}
              currentUserId={currentUserId} projectOwnerId={getProject(t.projectId)?.ownerId ?? null} tags={tags}
              onClose={() => setSaveTemplateFor(null)} />
          </Suspense>
        );
      })()}
      <Deferred when={extract.open}><ExtractTasksSheet open={extract.open} onClose={() => setExtract({ open: false })} initialText={extract.text} context={extract.context}
        projects={wsProjects} members={assignees} defaultProjectId={openProject?.id} currentUserId={currentUserId}
        onExtractAI={aiOn ? (text, context) => store.aiExtract(text, { ...askContext, hint: context }) : undefined}
        onCreate={(rows) => importTasks(rows, { verb: "Added" })} /></Deferred>
      <Deferred when={shutdownOpen}><ShutdownSheet open={shutdownOpen} onClose={() => setShutdownOpen(false)} tasks={myTasks} allTasks={allTasks} currentUserId={currentUserId} userName={currentUser?.name}
        onPatch={guardedPatch} onComment={(taskId, body) => addComment(taskId, body)} focusMinutesToday={focus.focusMinToday} readOnly={activeReadOnly} /></Deferred>
      <Deferred when={weeklyOpen}><WeeklyReview open={weeklyOpen} onClose={() => setWeeklyOpen(false)} tasks={myTasks} allTasks={allTasks} currentUserId={currentUserId} onPatch={guardedPatch}
        onSummarise={aiOn ? () => store.aiSummary(myTasks, dayKey) : undefined} readOnly={activeReadOnly} /></Deferred>
      <Deferred when={upgradeOpen}><UpgradeModal open={upgradeOpen} onClose={() => setUpgradeOpen(false)} seats={Math.max(1, wsMembers.filter((m) => m.status === "active").length || 1)} busyPlan={checkoutBusy} onChoose={startCheckout} /></Deferred>
      {deleteProjectId && (() => {
        const proj = getProject(deleteProjectId);
        if (!proj) return null;
        // counted from every task (an archived project's tasks aren't in allTasks), so a
        // project holding only archived tasks never claims to be empty
        const own = tasks.filter((t) => t.projectId === deleteProjectId);
        return <Suspense fallback={null}><DeleteProjectModal project={proj} taskCount={own.filter((t) => !t.archivedAt).length} archivedCount={own.filter((t) => !!t.archivedAt).length} projects={projects}
          onArchive={proj.archivedAt || !canArchiveProject(proj, { myRole: roleIn(proj.workspaceId) }) ? undefined : () => setProjectArchived(proj.id, true)}
          onConfirm={(mode, target) => { confirmDeleteProject(deleteProjectId, mode, target); }} onClose={() => setDeleteProjectId(null)} /></Suspense>;
      })()}
      {/* 0048 drag to plan: what's under the pointer while a task is carried, and the live region for pick-up and drop */}
      <DragLayer getTaskTitle={(id) => (seenRef.current ?? []).find((t) => t.id === id)?.title} />
      {/* 0048 the guided tour: mounted while one can run (a new account, part-way through, or asked for from Help or the
          first-run sheet); its coach marks sit above the task panel and below dialogs, ⌘K and toasts */}
      {(tourWanted || shouldAutoStartTour(onboarding, { isNewAccount })) && profile?.suspended !== true && (
        <ErrorBoundary inline floating name="tour">
          <Suspense fallback={null}>
            <TourHost role={tourRole} onboarding={onboarding} onChange={changeOnboarding} isNewAccount={isNewAccount}
              onNavigate={(r) => setRoute(r)}
              onOpenTask={(id) => { const t = (seenRef.current ?? []).find((x) => x.id === id); if (t) setWorkspace(t.workspaceId ?? null); setDetailId(id); }} />
          </Suspense>
        </ErrorBoundary>
      )}
      {/* one time, for people who knew the old layout: where everything went (out of
          the way while a task panel is open, where the card would sit on its composer) */}
      {knewOldLayout && !onboardOpen && !welcomeOpen && <WhatMoved isMobile={isMobile} hidden={!!detailId} onShowMe={() => openPalette()} />}
    </div>
  );
}

/** An overlay that's mounted (and its code fetched) the first time `when` is true, then kept
 *  mounted as it always was (exit fades, a kept draft). Before that: nothing at all. */
function Deferred({ when, children }: { when: boolean; children: React.ReactNode }) {
  const [opened, setOpened] = useState(when);
  if (when && !opened) setOpened(true);
  return opened || when ? <Suspense fallback={null}>{children}</Suspense> : null;
}

/** A one-line notice across the top of the page (offline, syncing, unsaved,
 *  guest, an announcement): 32px, the tone's colour on a faint tint of itself. */
function Notice({ tone, icon, role = "status", spin, actions, children }: {
  tone: "signal" | "warn" | "accent" | "ok" | "neutral";
  icon: IconName;
  role?: "status" | "note";
  spin?: boolean;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const ink = { signal: "var(--signal, var(--st-blocked))", warn: "var(--warn, var(--st-review))", accent: "var(--accent-text, var(--accent))", ok: "var(--ok, var(--st-done))", neutral: "var(--ink-3)" }[tone];
  return (
    <div role={role} style={{
      display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", minHeight: 32, padding: "2px var(--gutter, 32px)", flexShrink: 0,
      background: tone === "neutral" ? "var(--fill-1, var(--surface-2))" : `color-mix(in oklch, ${ink} 8%, var(--bg))`,
      borderBottom: `1px solid ${tone === "neutral" ? "var(--hairline)" : `color-mix(in oklch, ${ink} 22%, transparent)`}`,
    }}>
      <Icon name={icon} size={14} className={spin ? "spin" : undefined} style={{ color: ink, flexShrink: 0 }} />
      <span style={{ flex: 1, minWidth: 200, fontSize: "var(--t-ui, 13px)", lineHeight: "var(--lh-ui, 20px)", fontWeight: 500, color: "var(--ink-2)" }}>{children}</span>
      {actions && <span style={{ display: "inline-flex", alignItems: "center", gap: 4, marginRight: -8 }}>{actions}</span>}
    </div>
  );
}
