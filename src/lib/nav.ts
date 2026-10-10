/* ============================================================
   KANBO — navigation: the five places, their tabs, and every
   address. The single source for the sidebar, the phone bar, the
   page header's tabs, ⌘K "Go to", the g-keys and the URL.

   Today      /today · /today/week · /today/month · /today/overview
   Inbox      /inbox
   My tasks   /tasks · /tasks/waiting · /tasks/done  (?due=today|overdue|week)
   Search     /search · /search/list/:id
   Projects   /projects · /projects/portfolios · /projects/goals
              /projects/rules · /projects/requests · /projects/bin
              /p/:id · /p/:id/:tab · /p/:id/docs/:docId
   Team       /team · /team/people · /team/workload
              /team/insights · /team/insights/trends

   Old addresses (/home, /plan, /analytics …) are aliases: they
   resolve to a route, and canonicalPath() names the address to
   replaceState to. /admin, /privacy and /terms are never the app's.
   ============================================================ */
import type { Route, ViewId, ProjectTab } from "../app-types";
import type { IconName } from "../data/types";

export type PlaceId = "today" | "inbox" | "tasks" | "projects" | "team";

export interface NavCtx {
  /** the Personal workspace (no team: Team shows as Insights) */
  personal: boolean;
  /** a guest in this workspace (view and comment only) */
  guest: boolean;
  /** an owner or admin of this workspace */
  admin: boolean;
}

export interface PlaceTab {
  id: string;
  label: string;
  route: Route;
  adminOnly?: boolean;
  hiddenForGuest?: boolean;
  /** set apart after a divider (Projects › Rules · Requests) */
  secondary?: boolean;
}

export interface Place {
  id: PlaceId;
  label: string;
  icon: IconName;
  group: "me" | "team";
  gKey: string;
  route: Route;
  tabs: PlaceTab[];
}

/** The five places, in sidebar order. */
export const PLACES: Place[] = [
  {
    id: "today", label: "Today", icon: "sun", group: "me", gKey: "d", route: { view: "plan" },
    tabs: [
      { id: "plan", label: "Day", route: { view: "plan" } },
      { id: "myweek", label: "Week", route: { view: "myweek" } },
      { id: "calendar", label: "Month", route: { view: "calendar" } },
    ],
  },
  { id: "inbox", label: "Inbox", icon: "inbox", group: "me", gKey: "i", route: { view: "inbox" }, tabs: [] },
  {
    id: "tasks", label: "My tasks", icon: "tasks", group: "me", gKey: "t", route: { view: "tasks" },
    tabs: [
      { id: "open", label: "Open", route: { view: "tasks" } },
      { id: "waiting", label: "Waiting on", route: { view: "tasks", tab: "waiting" } },
      { id: "done", label: "Done", route: { view: "tasks", tab: "done" } },
    ],
  },
  {
    id: "projects", label: "Projects", icon: "kanbo", group: "team", gKey: "o", route: { view: "projects" },
    tabs: [
      { id: "projects", label: "All", route: { view: "projects" } },
      { id: "portfolios", label: "Portfolios", route: { view: "portfolios" } },
      { id: "goals", label: "Goals", route: { view: "goals" } },
      { id: "automations", label: "Rules", route: { view: "automations" }, secondary: true, hiddenForGuest: true },
      { id: "forms", label: "Requests", route: { view: "forms" }, secondary: true },
    ],
  },
  {
    id: "team", label: "Team", icon: "users", group: "team", gKey: "e", route: { view: "pulse" },
    tabs: [
      { id: "pulse", label: "Pulse", route: { view: "pulse" } },
      { id: "team", label: "People", route: { view: "team" } },
      { id: "workload", label: "Workload", route: { view: "workload" } },
      { id: "analytics", label: "Insights", route: { view: "analytics" } },
    ],
  },
];

const placeById = (id: PlaceId): Place => PLACES.find((p) => p.id === id)!;

export interface NavItem { id: PlaceId | "insights"; label: string; icon: IconName; group: "me" | "team"; route: Route }

/** The sidebar and drawer entries. In Personal, Team is Insights (there's no team to show). */
export function navItems(ctx: NavCtx): NavItem[] {
  return PLACES.map((p): NavItem => (p.id === "team" && ctx.personal
    ? { id: "insights", label: "Insights", icon: "chart", group: "team", route: { view: "analytics" } }
    : { id: p.id, label: p.label, icon: p.icon, group: p.group, route: p.route }));
}

const PLACE_OF: Record<ViewId, PlaceId> = {
  plan: "today", myweek: "today", calendar: "today", home: "today",
  inbox: "inbox",
  tasks: "tasks", search: "tasks",
  projects: "projects", portfolios: "projects", goals: "projects", automations: "projects", forms: "projects", project: "projects", bin: "projects",
  pulse: "team", team: "team", workload: "team", analytics: "team", reports: "team",
};

/** Which place a route belongs to — what the sidebar and phone bar highlight. */
export function placeOf(route: Route): PlaceId {
  return PLACE_OF[route.view] ?? "today";
}

/** A place's tabs for this person: guests lose Rules; Personal's Team has none
 *  (Insights' Overview / Trends switch lives in the page). */
export function tabsFor(place: PlaceId, ctx: NavCtx): PlaceTab[] {
  if (place === "team" && ctx.personal) return [];
  return placeById(place).tabs.filter((t) => !(t.hiddenForGuest && ctx.guest) && !(t.adminOnly && !ctx.admin));
}

/* ---------------- addresses ---------------- */

const PROJECT_TABS: readonly ProjectTab[] = ["list", "board", "timeline", "calendar", "files", "matrix", "updates", "requests", "rules", "about", "docs"];
const TASKS_TABS = ["waiting", "done"] as const;           // "open" is the bare /tasks
const DUE_FOCUS = ["today", "overdue", "week"] as const;
const RESERVED = new Set(["/admin", "/privacy", "/terms"]);

const isOneOf = <T extends string>(list: readonly T[], v: string | null | undefined): v is T => !!v && (list as readonly string[]).includes(v);

/** Fixed paths: canonical ones and their old aliases alike. */
const PATHS: Record<string, Route> = {
  "/today": { view: "plan" },
  "/today/week": { view: "myweek" },
  "/today/month": { view: "calendar" },
  "/today/overview": { view: "home" },
  "/inbox": { view: "inbox" },
  "/tasks": { view: "tasks" },
  "/tasks/open": { view: "tasks" },
  "/tasks/waiting": { view: "tasks", tab: "waiting" },
  "/tasks/done": { view: "tasks", tab: "done" },
  "/search": { view: "search" },
  "/projects": { view: "projects" },
  "/projects/portfolios": { view: "portfolios" },
  "/projects/goals": { view: "goals" },
  "/projects/rules": { view: "automations" },
  "/projects/requests": { view: "forms" },
  "/projects/bin": { view: "bin" },
  "/team": { view: "pulse" },
  "/team/pulse": { view: "pulse" },
  "/team/people": { view: "team" },
  "/team/workload": { view: "workload" },
  "/team/insights": { view: "analytics" },
  "/team/insights/trends": { view: "reports" },
  // aliases — the old addresses
  "/": { view: "plan" },
  "/home": { view: "plan" },
  "/plan": { view: "plan" },
  "/week": { view: "myweek" },
  "/calendar": { view: "calendar" },
  "/analytics": { view: "analytics" },
  "/reports": { view: "reports" },
  "/goals": { view: "goals" },
  "/portfolios": { view: "portfolios" },
  "/automations": { view: "automations" },
  "/forms": { view: "forms" },
  "/workload": { view: "workload" },
  "/people": { view: "team" },
};

const VIEW_PATH: Record<Exclude<ViewId, "tasks" | "search" | "project">, string> = {
  plan: "/today", myweek: "/today/week", calendar: "/today/month", home: "/today/overview",
  inbox: "/inbox",
  projects: "/projects", portfolios: "/projects/portfolios", goals: "/projects/goals", automations: "/projects/rules", forms: "/projects/requests", bin: "/projects/bin",
  pulse: "/team", team: "/team/people", workload: "/team/workload", analytics: "/team/insights", reports: "/team/insights/trends",
};

const clean = (pathname: string): string => {
  const p = ("/" + pathname).replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  return p || "/";
};
const decode = (s: string): string => { try { return decodeURIComponent(s); } catch { return s; } };

/** A route's canonical address, with its query (only My tasks' due focus lives in the query). */
export function pathOf(route: Route): string {
  switch (route.view) {
    case "tasks": {
      const tab = isOneOf(TASKS_TABS, route.tab) ? `/${route.tab}` : "";
      const q = new URLSearchParams();
      if (isOneOf(DUE_FOCUS, route.list)) q.set("due", route.list);
      if (route.savedViewId) q.set("view", route.savedViewId);
      const qs = q.toString();
      return `/tasks${tab}${qs ? `?${qs}` : ""}`;
    }
    case "search":
      return route.list ? `/search/list/${encodeURIComponent(route.list)}` : "/search";
    case "project": {
      if (!route.projectId) return "/projects";
      const tab = isOneOf(PROJECT_TABS, route.tab) ? `/${route.tab}` : "";
      const doc = route.tab === "docs" && route.docId ? `/${encodeURIComponent(route.docId)}` : "";
      const view = route.savedViewId && route.tab !== "docs" ? `?view=${encodeURIComponent(route.savedViewId)}` : "";
      return `/p/${encodeURIComponent(route.projectId)}${tab}${doc}${view}`;
    }
    default:
      return VIEW_PATH[route.view] ?? "/today";
  }
}

/** The route at an address. Unknown addresses land on Today (or, under a
 *  known place, on that place); null for the pages that aren't the app's. */
export function routeOf(pathname: string, search = ""): Route | null {
  const path = clean(pathname);
  if (RESERVED.has(path)) return null;
  const params = new URLSearchParams(search);
  const savedViewId = params.get("view") || undefined;   // 0048: a saved view applied (My tasks, a project)
  const fixed = PATHS[path];
  if (fixed) {
    if (fixed.view !== "tasks") return { ...fixed };
    const due = params.get("due");
    const r: Route = isOneOf(DUE_FOCUS, due) ? { ...fixed, list: due } : { ...fixed };
    return savedViewId ? { ...r, savedViewId } : r;
  }
  const seg = path.split("/").slice(1);
  if (seg[0] === "p") {
    if (!seg[1]) return { view: "projects" };
    const route: Route = { view: "project", projectId: decode(seg[1]) };
    if (seg[2] === "docs" && seg[3]) return { ...route, tab: "docs", docId: decode(seg[3]) };
    const r: Route = isOneOf(PROJECT_TABS, seg[2]) ? { ...route, tab: seg[2] } : route;
    return savedViewId && r.tab !== "docs" ? { ...r, savedViewId } : r;
  }
  if (seg[0] === "search") {
    return seg[1] === "list" && seg[2] ? { view: "search", list: decode(seg[2]) } : { view: "search" };
  }
  const home: Record<string, Route> = { today: { view: "plan" }, inbox: { view: "inbox" }, tasks: { view: "tasks" }, projects: { view: "projects" }, team: { view: "pulse" } };
  return home[seg[0]] ? { ...home[seg[0]] } : { view: "plan" };
}

/** The canonical address for this one (alias → canonical), keeping every
 *  other query parameter (?task=, ?calendar=, billing returns …). Compare it
 *  with the current address to decide on replaceState. Null for /admin,
 *  /privacy and /terms. */
export function canonicalPath(pathname: string, search = ""): string | null {
  const route = routeOf(pathname, search);
  if (!route) return null;
  const [path, own = ""] = pathOf(route).split("?");
  const params = new URLSearchParams(own);
  new URLSearchParams(search).forEach((v, k) => { if (k !== "due" && k !== "view") params.append(k, v); });
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/* ---------------- keys, ⌘K "Go to", titles ---------------- */

/** "g" then a key. */
export const G_KEYS: Record<string, Route> = {
  d: { view: "plan" },
  p: { view: "plan" },
  h: { view: "home" },
  i: { view: "inbox" },
  t: { view: "tasks" },
  c: { view: "calendar" },
  s: { view: "search" },
  a: { view: "analytics" },
  r: { view: "reports" },
  w: { view: "myweek" },
  o: { view: "projects" },
  e: { view: "pulse" },
};

export interface GoTarget { id: string; label: string; keywords: string; icon: IconName; route: Route; hint?: string }

/** Every place, every tab, and the old names people will still type. */
export const GO_TARGETS: GoTarget[] = [
  { id: "today", label: "Today", keywords: "today day plan my day planner home dashboard", icon: "sun", route: { view: "plan" }, hint: "G D" },
  { id: "week", label: "Week", keywords: "my week this week weekly review big 3", icon: "calendarPlus", route: { view: "myweek" }, hint: "G W" },
  { id: "month", label: "Month", keywords: "calendar month schedule", icon: "calendar", route: { view: "calendar" }, hint: "G C" },
  { id: "overview", label: "Overview (classic Home)", keywords: "home overview dashboard classic", icon: "home", route: { view: "home" }, hint: "G H" },
  { id: "inbox", label: "Inbox", keywords: "inbox notifications mentions assignments updates bell", icon: "inbox", route: { view: "inbox" }, hint: "G I" },
  { id: "tasks", label: "My tasks", keywords: "my tasks my work open to do todo assigned to me", icon: "tasks", route: { view: "tasks" }, hint: "G T" },
  { id: "waiting", label: "Waiting on", keywords: "waiting on delegated follow up others", icon: "hourglass", route: { view: "tasks", tab: "waiting" } },
  { id: "done", label: "Done", keywords: "done completed finished logbook", icon: "check", route: { view: "tasks", tab: "done" } },
  { id: "due-today", label: "Due today", keywords: "due today smart list", icon: "clock", route: { view: "tasks", list: "today" } },
  { id: "overdue", label: "Overdue", keywords: "overdue late smart list", icon: "flag", route: { view: "tasks", list: "overdue" } },
  { id: "due-week", label: "Due this week", keywords: "due this week next 7 days smart list", icon: "calendar", route: { view: "tasks", list: "week" } },
  { id: "assigned-all", label: "Assigned to me (all workspaces)", keywords: "assigned to me mine all workspaces smart lists", icon: "user", route: { view: "search", list: "mine" } },
  { id: "search", label: "Search", keywords: "search find advanced search smart lists saved searches", icon: "search", route: { view: "search" }, hint: "G S" },
  { id: "projects", label: "Projects", keywords: "projects all projects directory", icon: "kanbo", route: { view: "projects" }, hint: "G O" },
  { id: "portfolios", label: "Portfolios", keywords: "portfolios projects rolled up exec", icon: "briefcase", route: { view: "portfolios" } },
  { id: "goals", label: "Goals", keywords: "goals okrs objectives key results", icon: "target", route: { view: "goals" } },
  { id: "rules", label: "Rules", keywords: "rules automations automation", icon: "zap", route: { view: "automations" } },
  { id: "requests", label: "Requests", keywords: "requests forms form intake", icon: "inbox", route: { view: "forms" } },
  { id: "bin", label: "Recycle bin", keywords: "recycle bin trash deleted restore undelete recover", icon: "trash", route: { view: "bin" } },
  { id: "pulse", label: "Pulse", keywords: "team pulse standup stand-up daily radar risks", icon: "pulse", route: { view: "pulse" }, hint: "G E" },
  { id: "people", label: "People", keywords: "team people members invite roles", icon: "users", route: { view: "team" } },
  { id: "workload", label: "Workload", keywords: "workload capacity load", icon: "chart", route: { view: "workload" } },
  { id: "insights", label: "Insights", keywords: "insights analytics overview stats metrics", icon: "trendingUp", route: { view: "analytics" }, hint: "G A" },
  { id: "trends", label: "Trends", keywords: "trends reports velocity cycle time", icon: "chart", route: { view: "reports" }, hint: "G R" },
];

/** One row of Settings › Shortcuts. `keys`: keys pressed in turn are separated
 *  by a space ("G D"); a chord is one token ("⌘K", "⇧J"); alternatives are
 *  joined with " / " ("J / K"). ⌘ reads as Ctrl on Windows and Linux. */
export interface Shortcut { keys: string; label: string; group: "Navigate" | "Create" | "Lists" | "Today" | "Inbox" | "Docs" | "General" }

export const SHORTCUTS: Shortcut[] = [
  { keys: "⌘K", label: "Search or ask Kanbo", group: "General" },
  { keys: "/", label: "Search or ask Kanbo", group: "General" },
  { keys: "⌘,", label: "Settings", group: "General" },
  { keys: "⌘Z", label: "Undo the last change", group: "General" },
  { keys: "F", label: "Focus", group: "General" },
  { keys: "?", label: "Keyboard shortcuts", group: "General" },
  { keys: "Esc", label: "Close", group: "General" },
  { keys: "C", label: "New task", group: "Create" },
  { keys: "Q", label: "Quick capture", group: "Create" },
  { keys: "G D", label: "Today", group: "Navigate" },
  { keys: "G P", label: "Today (Plan my day)", group: "Navigate" },
  { keys: "G W", label: "Week", group: "Navigate" },
  { keys: "G C", label: "Month", group: "Navigate" },
  { keys: "G H", label: "Overview", group: "Navigate" },
  { keys: "G I", label: "Inbox", group: "Navigate" },
  { keys: "G T", label: "My tasks", group: "Navigate" },
  { keys: "G S", label: "Search", group: "Navigate" },
  { keys: "G O", label: "Projects", group: "Navigate" },
  { keys: "G E", label: "Team", group: "Navigate" },
  { keys: "G A", label: "Insights", group: "Navigate" },
  { keys: "G R", label: "Trends", group: "Navigate" },
  { keys: "P", label: "Plan my day", group: "Today" },
  { keys: "⏎", label: "Accept the focused suggestion", group: "Today" },
  { keys: "H", label: "Hide suggestions", group: "Today" },
  { keys: "S", label: "Schedule the focused task", group: "Today" },
  { keys: "⌥↑ / ⌥↓", label: "Make the focused block shorter / longer (your own tasks)", group: "Today" },
  { keys: "⇧F10", label: "Move to… (Week)", group: "Today" },
  { keys: "J / K", label: "Move down / up", group: "Lists" },
  { keys: "X", label: "Select", group: "Lists" },
  { keys: "⇧J / ⇧K", label: "Extend the selection", group: "Lists" },
  { keys: "⏎", label: "Open", group: "Lists" },
  { keys: "S", label: "Status", group: "Lists" },
  { keys: "P", label: "Priority", group: "Lists" },
  { keys: "D", label: "Due date", group: "Lists" },
  { keys: "A", label: "Assign", group: "Lists" },
  { keys: "⌘⏎", label: "Complete", group: "Lists" },
  { keys: "E", label: "Rename", group: "Lists" },
  { keys: "T", label: "Add to Today", group: "Lists" },
  { keys: "M", label: "Move to project", group: "Lists" },
  { keys: "L", label: "Labels", group: "Lists" },
  { keys: "J / K", label: "Move down / up", group: "Inbox" },
  { keys: "R", label: "Reply", group: "Inbox" },
  { keys: "A", label: "Add to Today", group: "Inbox" },
  { keys: "D", label: "Schedule", group: "Inbox" },
  { keys: "H", label: "Snooze", group: "Inbox" },
  { keys: "E", label: "Done", group: "Inbox" },
  { keys: "A", label: "Approve (Approvals for you)", group: "Inbox" },
  { keys: "C", label: "Request changes (Approvals for you)", group: "Inbox" },
  { keys: "/", label: "Insert a block", group: "Docs" },
  { keys: "@", label: "Mention someone", group: "Docs" },
  { keys: "⌘B / ⌘I / ⌘E", label: "Bold / italic / code", group: "Docs" },
  { keys: "⌘K", label: "Add a link", group: "Docs" },
  { keys: "⌘/", label: "Block actions", group: "Docs" },
  { keys: "Esc", label: "Select blocks", group: "Docs" },
  { keys: "⌘⇧↑ / ⌘⇧↓", label: "Move a block up / down", group: "Docs" },
  { keys: "⌘D", label: "Duplicate a block", group: "Docs" },
  { keys: "⌘↵", label: "Tick a to-do, or open its task", group: "Docs" },
];

/** The page's name, for the header and the tab title. A project's page is
 *  titled by the project's name, which only the caller knows. Personal has no
 *  team, so its Team place is Insights; People and Workload keep their own
 *  names there when an address still leads to them. */
export function titleOf(route: Route, ctx?: Pick<NavCtx, "personal">): string {
  switch (placeOf(route)) {
    case "today": return "Today";
    case "inbox": return "Inbox";
    case "tasks": return route.view === "search" ? "Search" : "My tasks";
    case "projects": return "Projects";
    case "team":
      if (!ctx?.personal) return "Team";
      return route.view === "team" ? "People" : route.view === "workload" ? "Workload" : "Insights";
  }
}
