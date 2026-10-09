/* ============================================================
   KANBO — the app's code, split by screen.

   The shell (sidebar, page header, phone bar, the store) and Today
   come in the first download. Every other place, and everything
   opened on top (the task panel, ⌘K, Settings, the sheets and
   dialogs), is its own chunk, fetched:
     • when it's needed (its <Suspense> shows a skeleton of its layout),
     • a moment earlier, when the pointer or focus lands on a link to it
       (prefetchRoute: the sidebar, the phone bar, the page header's tabs),
     • or while the browser is idle: first the places someone is likely
       to go next (likelyNext: the task panel, Inbox, My tasks…), then
       every other screen (everyScreen), so the app still works offline
       as it did when it was one file. Never on Data Saver or 2G.
   ============================================================ */
import type { Route, ViewId } from "./app-types";
import { chunk, lazyComponent, prefetch, type Chunk } from "./lib/lazyLoad";
import { placeOf, tabsFor, type NavCtx } from "./lib/nav";

/** every screen's chunk, in the order declared below (places, then what opens on top) */
const ALL: Chunk[] = [];
const screen = <M>(load: () => Promise<M>): Chunk<M> => { const c = chunk(load); ALL.push(c as Chunk); return c; };

/* ---------- places ---------- */
const myWeek = screen(() => import("./components/views/MyWeekView"));
const otherViews = screen(() => import("./components/tasks/OtherViews"));      // Month (and the project views' board, timeline…)
const home = screen(() => import("./components/views/HomeView"));
const inbox = screen(() => import("./components/views/InboxView"));
const tasksPage = screen(() => import("./components/tasks/TasksPage"));
const projectHeader = screen(() => import("./components/project/ProjectHeader"));
const search = screen(() => import("./components/views/SearchView"));
const projectsView = screen(() => import("./components/views/ProjectsView"));
const goals = screen(() => import("./components/views/GoalsPortfolios"));
const rules = screen(() => import("./components/views/RulesForms"));
const bin = screen(() => import("./components/bin/RecycleBin"));
const pulse = screen(() => import("./components/views/TeamPulse"));
const team = screen(() => import("./components/views/TeamView"));
const workload = screen(() => import("./components/views/WorkloadView"));
const analytics = screen(() => import("./components/views/AnalyticsView"));
const reports = screen(() => import("./components/views/ReportsView"));
const docs = screen(() => import("./components/docs/DocsTab"));

export const MyWeekView = lazyComponent(myWeek, (m) => m.MyWeekView, "MyWeekView");
export const CalendarView = lazyComponent(otherViews, (m) => m.CalendarView, "CalendarView");
export const HomeView = lazyComponent(home, (m) => m.HomeView, "HomeView");
export const InboxView = lazyComponent(inbox, (m) => m.InboxView, "InboxView");
export const TasksPage = lazyComponent(tasksPage, (m) => m.TasksPage, "TasksPage");
export const ProjectTitleAddon = lazyComponent(projectHeader, (m) => m.ProjectTitleAddon, "ProjectTitleAddon");
export const ProjectActions = lazyComponent(projectHeader, (m) => m.ProjectActions, "ProjectActions");
export const ProjectPanels = lazyComponent(projectHeader, (m) => m.ProjectPanels, "ProjectPanels");
export const ProjectNotice = lazyComponent(projectHeader, (m) => m.ProjectNotice, "ProjectNotice");
export const SearchView = lazyComponent(search, (m) => m.SearchView, "SearchView");
export const ProjectsView = lazyComponent(projectsView, (m) => m.ProjectsView, "ProjectsView");
export const GoalsView = lazyComponent(goals, (m) => m.GoalsView, "GoalsView");
export const PortfoliosView = lazyComponent(goals, (m) => m.PortfoliosView, "PortfoliosView");
export const AutomationsView = lazyComponent(rules, (m) => m.AutomationsView, "AutomationsView");
export const FormsView = lazyComponent(rules, (m) => m.FormsView, "FormsView");
export const RecycleBin = lazyComponent(bin, (m) => m.RecycleBin, "RecycleBin");
export const TeamPulse = lazyComponent(pulse, (m) => m.TeamPulse, "TeamPulse");
export const TeamView = lazyComponent(team, (m) => m.TeamView, "TeamView");
export const WorkspaceSettingsPanel = lazyComponent(team, (m) => m.WorkspaceSettingsPanel, "WorkspaceSettingsPanel");
export const WorkloadView = lazyComponent(workload, (m) => m.WorkloadView, "WorkloadView");
export const AnalyticsView = lazyComponent(analytics, (m) => m.AnalyticsView, "AnalyticsView");
export const ReportsView = lazyComponent(reports, (m) => m.ReportsView, "ReportsView");
export const DocsTab = lazyComponent(docs, (m) => m.DocsTab, "DocsTab");

/* ---------- on top of a page ---------- */
const taskDetail = screen(() => import("./components/TaskDetail"));
const palette = screen(() => import("./components/CommandPalette"));
const settings = screen(() => import("./components/SettingsModal"));
const newTask = screen(() => import("./components/NewTaskModal"));
const newProject = screen(() => import("./components/NewProjectModal"));
const newWorkspace = screen(() => import("./components/NewWorkspaceModal"));
const deleteProject = screen(() => import("./components/DeleteProjectModal"));
const importTasks = screen(() => import("./components/ImportTasksModal"));
const onboarding = screen(() => import("./components/OnboardingModal"));
const welcome = screen(() => import("./components/WelcomeModal"));
const quickCapture = screen(() => import("./components/QuickCapture"));
const extract = screen(() => import("./components/ExtractTasksSheet"));
const shutdown = screen(() => import("./components/rituals/ShutdownSheet"));
const weekly = screen(() => import("./components/rituals/WeeklyReview"));
const focus = screen(() => import("./components/views/FocusMode"));
const planner = screen(() => import("./components/planner/PlannerHost"));
const billing = screen(() => import("./components/Billing"));

export const TaskDetail = lazyComponent(taskDetail, (m) => m.TaskDetail, "TaskDetail");
export const CommandPalette = lazyComponent(palette, (m) => m.CommandPalette, "CommandPalette");
export const SettingsModal = lazyComponent(settings, (m) => m.SettingsModal, "SettingsModal");
export const NewTaskModal = lazyComponent(newTask, (m) => m.NewTaskModal, "NewTaskModal");
export const NewProjectModal = lazyComponent(newProject, (m) => m.NewProjectModal, "NewProjectModal");
export const NewWorkspaceModal = lazyComponent(newWorkspace, (m) => m.NewWorkspaceModal, "NewWorkspaceModal");
export const DeleteProjectModal = lazyComponent(deleteProject, (m) => m.DeleteProjectModal, "DeleteProjectModal");
export const ImportTasksModal = lazyComponent(importTasks, (m) => m.ImportTasksModal, "ImportTasksModal");
export const OnboardingModal = lazyComponent(onboarding, (m) => m.OnboardingModal, "OnboardingModal");
export const WelcomeModal = lazyComponent(welcome, (m) => m.WelcomeModal, "WelcomeModal");
export const QuickCapture = lazyComponent(quickCapture, (m) => m.QuickCapture, "QuickCapture");
export const ExtractTasksSheet = lazyComponent(extract, (m) => m.ExtractTasksSheet, "ExtractTasksSheet");
export const ShutdownSheet = lazyComponent(shutdown, (m) => m.ShutdownSheet, "ShutdownSheet");
export const WeeklyReview = lazyComponent(weekly, (m) => m.WeeklyReview, "WeeklyReview");
export const FocusMode = lazyComponent(focus, (m) => m.FocusMode, "FocusMode");
export const PlannerHost = lazyComponent(planner, (m) => m.PlannerHost, "PlannerHost");
export const TrialBanner = lazyComponent(billing, (m) => m.TrialBanner, "TrialBanner");
export const UpgradeModal = lazyComponent(billing, (m) => m.UpgradeModal, "UpgradeModal");
export const Paywall = lazyComponent(billing, (m) => m.Paywall, "Paywall");

/* ---------- which chunks a route needs ---------- */
const VIEW_CHUNKS: Record<ViewId, Chunk[]> = {
  plan: [], myweek: [myWeek], calendar: [otherViews], home: [home],
  inbox: [inbox],
  tasks: [tasksPage], search: [search],
  projects: [projectsView], portfolios: [goals], goals: [goals], automations: [rules], forms: [rules],
  project: [tasksPage, projectHeader], bin: [bin],
  pulse: [pulse], team: [team], workload: [workload], analytics: [analytics], reports: [reports],
};

/** The chunks a route's page is drawn from (none for Today: it's in the shell). */
export function chunksFor(route: Route): Chunk[] {
  const list = VIEW_CHUNKS[route.view] ?? [];
  return route.view === "project" && route.tab === "docs" ? [...list, docs] : list;
}

/** Hover or focus on a link to `route`: start fetching its page. */
export function prefetchRoute(route: Route | null | undefined): void {
  if (route) prefetch(...chunksFor(route));
}

/** The handlers that prefetch a route's page, for a nav item that isn't a link. */
export function prefetchProps(route: Route): { onPointerEnter: () => void; onFocus: () => void } {
  const go = () => prefetchRoute(route);
  return { onPointerEnter: go, onFocus: go };
}

/** Quick capture is about to open (a finger on the phone bar's +): its code should be
 *  in before the tap lands, so it opens — and focuses, raising the keyboard — at once. */
export function prefetchCapture(): void {
  prefetch(quickCapture);
}

/** Every screen the app can show (the idle warm-up's tail). */
export function everyScreen(): Chunk[] {
  return [...ALL];
}

/** What someone on `route` is likely to open next, most likely first: the task
 *  panel and quick capture (it has to open, and focus, the moment it's asked for),
 *  the other everyday places, this place's own tabs, ⌘K and New task, then a
 *  project (from Projects). Idle-time only. */
export function likelyNext(route: Route, ctx: NavCtx): Chunk[] {
  const place = placeOf(route);
  const tabs = tabsFor(place, ctx).flatMap((t) => chunksFor(t.route));
  const out: Chunk[] = [taskDetail, quickCapture, ...chunksFor({ view: "inbox" }), ...chunksFor({ view: "tasks" }), ...tabs, palette, newTask];
  if (place === "projects") out.push(...chunksFor({ view: "project" }));
  out.push(...chunksFor({ view: "projects" }));
  return out;
}
