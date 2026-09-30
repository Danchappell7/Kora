import { describe, it, expect } from "vitest";
import {
  PLACES, navItems, placeOf, tabsFor, pathOf, routeOf, canonicalPath, G_KEYS, GO_TARGETS, SHORTCUTS, titleOf, type NavCtx,
} from "./nav";
import type { Route, ViewId, ProjectTab } from "../app-types";

const VIEWS: ViewId[] = [
  "plan", "home", "inbox", "tasks", "calendar", "team", "analytics", "reports", "project", "search",
  "goals", "portfolios", "workload", "automations", "forms", "myweek", "projects", "pulse",
];
const PROJECT_TABS: ProjectTab[] = ["list", "board", "timeline", "calendar", "files", "matrix", "updates", "requests", "rules", "about"];
const TEAM: NavCtx = { personal: false, guest: false, admin: false };
const PERSONAL: NavCtx = { personal: true, guest: false, admin: true };
const GUEST: NavCtx = { personal: false, guest: true, admin: false };

const roundTrip = (r: Route) => {
  const [path, query] = pathOf(r).split("?");
  return routeOf(path, query ? `?${query}` : "");
};

describe("addresses round-trip", () => {
  it("for every view", () => {
    for (const view of VIEWS) {
      const r: Route = view === "project" ? { view, projectId: "p-launch" } : { view };
      expect(roundTrip(r), view).toEqual(r);
    }
  });

  it("for every project tab, and ids that need encoding", () => {
    for (const tab of PROJECT_TABS) {
      const r: Route = { view: "project", projectId: "p-launch", tab };
      expect(pathOf(r)).toBe(`/p/p-launch/${tab}`);
      expect(roundTrip(r)).toEqual(r);
    }
    const odd: Route = { view: "project", projectId: "a b/c" };
    expect(pathOf(odd)).toBe("/p/a%20b%2Fc");
    expect(roundTrip(odd)).toEqual(odd);
  });

  it("for My tasks' tabs and due focus", () => {
    expect(pathOf({ view: "tasks" })).toBe("/tasks");
    expect(pathOf({ view: "tasks", tab: "open" })).toBe("/tasks");
    expect(pathOf({ view: "tasks", tab: "waiting" })).toBe("/tasks/waiting");
    expect(pathOf({ view: "tasks", tab: "done" })).toBe("/tasks/done");
    for (const list of ["today", "overdue", "week"]) {
      const r: Route = { view: "tasks", list };
      expect(pathOf(r)).toBe(`/tasks?due=${list}`);
      expect(roundTrip(r)).toEqual(r);
    }
    expect(routeOf("/tasks", "?due=someday")).toEqual({ view: "tasks" });
  });

  it("for search, smart lists and saved searches", () => {
    for (const list of ["mine", "today", "overdue", "week", "0b6f5c1e-8f3c-4a6e-9d1a-2f3b4c5d6e7f"]) {
      const r: Route = { view: "search", list };
      expect(pathOf(r)).toBe(`/search/list/${list}`);
      expect(roundTrip(r)).toEqual(r);
    }
    expect(routeOf("/search", "?q=launch")).toEqual({ view: "search" });
  });

  it("names the canonical paths from the brief", () => {
    expect(pathOf({ view: "plan" })).toBe("/today");
    expect(pathOf({ view: "myweek" })).toBe("/today/week");
    expect(pathOf({ view: "calendar" })).toBe("/today/month");
    expect(pathOf({ view: "home" })).toBe("/today/overview");
    expect(pathOf({ view: "projects" })).toBe("/projects");
    expect(pathOf({ view: "portfolios" })).toBe("/projects/portfolios");
    expect(pathOf({ view: "goals" })).toBe("/projects/goals");
    expect(pathOf({ view: "automations" })).toBe("/projects/rules");
    expect(pathOf({ view: "forms" })).toBe("/projects/requests");
    expect(pathOf({ view: "pulse" })).toBe("/team");
    expect(pathOf({ view: "team" })).toBe("/team/people");
    expect(pathOf({ view: "workload" })).toBe("/team/workload");
    expect(pathOf({ view: "analytics" })).toBe("/team/insights");
    expect(pathOf({ view: "reports" })).toBe("/team/insights/trends");
    expect(pathOf({ view: "project" })).toBe("/projects");
  });
});

describe("aliases and odd addresses", () => {
  it("map the old addresses to their canonical ones", () => {
    const aliases: [string, string][] = [
      ["/", "/today"], ["/home", "/today"], ["/plan", "/today"], ["/week", "/today/week"], ["/calendar", "/today/month"],
      ["/analytics", "/team/insights"], ["/reports", "/team/insights/trends"], ["/goals", "/projects/goals"],
      ["/portfolios", "/projects/portfolios"], ["/automations", "/projects/rules"], ["/forms", "/projects/requests"],
      ["/workload", "/team/workload"], ["/people", "/team/people"], ["/tasks/open", "/tasks"],
    ];
    for (const [alias, canonical] of aliases) expect(canonicalPath(alias), alias).toBe(canonical);
  });

  it("send an unknown address to Today, and an unknown sub-page to its place", () => {
    expect(routeOf("/nowhere")).toEqual({ view: "plan" });
    expect(canonicalPath("/nowhere")).toBe("/today");
    expect(canonicalPath("/team/nowhere")).toBe("/team");
    expect(canonicalPath("/p/p-launch/nowhere")).toBe("/p/p-launch");
    expect(canonicalPath("/p")).toBe("/projects");
  });

  it("tolerate trailing and doubled slashes", () => {
    expect(routeOf("/tasks/done/")).toEqual({ view: "tasks", tab: "done" });
    expect(canonicalPath("//today//week/")).toBe("/today/week");
  });

  it("keep every other query parameter, in order", () => {
    expect(canonicalPath("/home", "?task=t-1")).toBe("/today?task=t-1");
    expect(canonicalPath("/tasks", "?task=t-1&due=today")).toBe("/tasks?due=today&task=t-1");
    expect(canonicalPath("/calendar", "?calendar=connected")).toBe("/today/month?calendar=connected");
    expect(canonicalPath("/today", "?billing=success&session_id=cs_1")).toBe("/today?billing=success&session_id=cs_1");
    expect(canonicalPath("/search", "?q=launch deck")).toBe("/search?q=launch+deck");
    expect(canonicalPath("/today", "?due=today")).toBe("/today");
  });

  it("are unchanged when already canonical", () => {
    for (const p of ["/today", "/inbox", "/tasks/waiting", "/p/p-launch/board", "/team/insights/trends", "/search/list/mine"]) {
      expect(canonicalPath(p)).toBe(p);
    }
  });

  it("never claim /admin, /privacy or /terms", () => {
    for (const p of ["/admin", "/admin/", "/privacy", "/terms"]) {
      expect(routeOf(p), p).toBeNull();
      expect(canonicalPath(p), p).toBeNull();
    }
  });
});

describe("places", () => {
  it("are the five, in sidebar order", () => {
    expect(PLACES.map((p) => p.id)).toEqual(["today", "inbox", "tasks", "projects", "team"]);
    expect(navItems(TEAM).map((n) => n.label)).toEqual(["Today", "Inbox", "My tasks", "Projects", "Team"]);
  });

  it("in Personal, Team is Insights", () => {
    const items = navItems(PERSONAL);
    expect(items.map((n) => n.label)).toEqual(["Today", "Inbox", "My tasks", "Projects", "Insights"]);
    expect(pathOf(items[4].route)).toBe("/team/insights");
    expect(tabsFor("team", PERSONAL)).toEqual([]);
  });

  it("highlight the right place for every view", () => {
    expect(placeOf({ view: "home" })).toBe("today");
    expect(placeOf({ view: "calendar" })).toBe("today");
    expect(placeOf({ view: "search" })).toBe("tasks");
    expect(placeOf({ view: "project", projectId: "p" })).toBe("projects");
    expect(placeOf({ view: "forms" })).toBe("projects");
    expect(placeOf({ view: "analytics" })).toBe("team");
    expect(placeOf({ view: "reports" })).toBe("team");
    for (const view of VIEWS) expect(PLACES.map((p) => p.id)).toContain(placeOf({ view }));
  });

  it("give guests no Rules tab", () => {
    expect(tabsFor("projects", TEAM).map((t) => t.label)).toEqual(["All", "Portfolios", "Goals", "Rules", "Requests"]);
    expect(tabsFor("projects", GUEST).map((t) => t.label)).toEqual(["All", "Portfolios", "Goals", "Requests"]);
    expect(tabsFor("projects", TEAM).filter((t) => t.secondary).map((t) => t.label)).toEqual(["Rules", "Requests"]);
  });

  it("have the tabs from the brief", () => {
    expect(tabsFor("today", TEAM).map((t) => t.label)).toEqual(["Day", "Week", "Month"]);
    expect(tabsFor("tasks", TEAM).map((t) => t.label)).toEqual(["Open", "Waiting on", "Done"]);
    expect(tabsFor("team", TEAM).map((t) => t.label)).toEqual(["Pulse", "People", "Workload", "Insights"]);
    expect(tabsFor("inbox", TEAM)).toEqual([]);
    // every tab's route belongs to its place
    for (const p of PLACES) for (const t of p.tabs) expect(placeOf(t.route)).toBe(p.id);
  });
});

describe("keys, Go to and titles", () => {
  it("g-keys cover the brief's map and each place's own key", () => {
    expect(Object.keys(G_KEYS).sort()).toEqual(["a", "c", "d", "e", "h", "i", "o", "p", "r", "s", "t", "w"]);
    for (const p of PLACES) expect(G_KEYS[p.gKey]).toEqual(p.route);
    expect(G_KEYS.h).toEqual({ view: "home" });
    expect(G_KEYS.a).toEqual({ view: "analytics" });
  });

  it("Go to reaches every view and answers to the old names", () => {
    const views = new Set(GO_TARGETS.map((g) => g.route.view));
    for (const view of VIEWS.filter((v) => v !== "project")) expect(views.has(view), view).toBe(true);
    expect(new Set(GO_TARGETS.map((g) => g.id)).size).toBe(GO_TARGETS.length);
    const words = GO_TARGETS.map((g) => `${g.label} ${g.keywords}`.toLowerCase()).join(" | ");
    for (const legacy of ["home", "plan my day", "analytics", "reports", "automations", "forms", "calendar", "portfolios", "goals", "okrs", "workload", "capacity", "search", "smart lists", "assigned to me", "due today", "overdue"]) {
      expect(words, legacy).toContain(legacy);
    }
  });

  it("the shortcuts list covers every g-key", () => {
    for (const k of Object.keys(G_KEYS)) expect(SHORTCUTS.some((s) => s.keys === `G ${k.toUpperCase()}`), k).toBe(true);
    expect(SHORTCUTS.every((s) => s.keys && s.label)).toBe(true);
  });

  it("titles each place", () => {
    expect(titleOf({ view: "myweek" })).toBe("Today");
    expect(titleOf({ view: "inbox" })).toBe("Inbox");
    expect(titleOf({ view: "tasks", tab: "done" })).toBe("My tasks");
    expect(titleOf({ view: "search" })).toBe("Search");
    expect(titleOf({ view: "goals" })).toBe("Projects");
    expect(titleOf({ view: "workload" })).toBe("Team");
    expect(titleOf({ view: "analytics" }, { personal: true })).toBe("Insights");
    expect(titleOf({ view: "reports" }, { personal: true })).toBe("Insights");
    // Personal has no team: an old address to People or Workload names the page it opens
    expect(titleOf({ view: "team" }, { personal: true })).toBe("People");
    expect(titleOf({ view: "workload" }, { personal: true })).toBe("Workload");
  });
});
