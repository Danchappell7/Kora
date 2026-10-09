/* lazyViews: which chunks each route needs, what's warmed while idle, the
   skeleton each page gets, and the build's vendor chunks. */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { chunksFor, everyScreen, likelyNext, prefetchProps, TaskDetail, InboxView, TasksPage, ProjectActions, DocsTab, CommandPalette, QuickCapture } from "./lazyViews";
import { PlaceSkeleton, PanelSkeleton, skeletonFor } from "./components/PlaceSkeleton";
import { vendorChunk } from "./lib/vendorChunks";
import type { ViewId } from "./app-types";
import mainSrc from "./main.tsx?raw";
import sheetsSrc from "./styles/globalSheets.ts?raw";

const VIEWS: ViewId[] = ["plan", "home", "inbox", "tasks", "calendar", "team", "analytics", "reports", "project", "search", "goals", "portfolios", "workload", "automations", "forms", "myweek", "projects", "pulse", "bin"];

describe("chunksFor", () => {
  it("Today is in the shell; every other page has its own code", () => {
    expect(chunksFor({ view: "plan" })).toEqual([]);
    for (const view of VIEWS.filter((v) => v !== "plan")) expect(chunksFor({ view }).length, view).toBeGreaterThan(0);
    expect(chunksFor({ view: "inbox" })).toEqual([InboxView.chunk]);
  });

  it("a project needs its task views and its header; its Docs tab, the docs code too", () => {
    expect(chunksFor({ view: "project", projectId: "p1" })).toEqual([TasksPage.chunk, ProjectActions.chunk]);
    expect(chunksFor({ view: "project", projectId: "p1", tab: "docs" })).toEqual([TasksPage.chunk, ProjectActions.chunk, DocsTab.chunk]);
  });

  it("Goals and Portfolios share a chunk, as do Rules and Requests", () => {
    expect(chunksFor({ view: "goals" })).toEqual(chunksFor({ view: "portfolios" }));
    expect(chunksFor({ view: "automations" })).toEqual(chunksFor({ view: "forms" }));
  });

  it("prefetchProps gives a nav button pointer and focus handlers", () => {
    const p = prefetchProps({ view: "plan" });
    expect(typeof p.onPointerEnter).toBe("function");
    expect(typeof p.onFocus).toBe("function");
    expect(() => p.onFocus()).not.toThrow();
  });
});

describe("idle warm-up", () => {
  const ctx = { personal: false, guest: false, admin: true };
  it("starts with the task panel and quick capture, then Inbox and My tasks, then the place's own tabs", () => {
    const next = likelyNext({ view: "pulse" }, ctx);
    expect(next.slice(0, 4)).toEqual([TaskDetail.chunk, QuickCapture.chunk, ...chunksFor({ view: "inbox" }), ...chunksFor({ view: "tasks" })]);
    for (const v of ["team", "workload", "analytics"] as const) expect(next).toContain(chunksFor({ view: v })[0]);
    expect(next).toContain(CommandPalette.chunk);
  });
  it("from Projects, a project's page is likely next", () => {
    expect(likelyNext({ view: "projects" }, ctx)).toEqual(expect.arrayContaining(chunksFor({ view: "project", projectId: "x" })));
  });
  it("then every screen, so the app still works offline", () => {
    const all = everyScreen();
    for (const view of VIEWS) for (const c of chunksFor({ view })) expect(all, view).toContain(c);
    expect(all).toContain(TaskDetail.chunk);
    expect(all).toContain(CommandPalette.chunk);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("place skeletons", () => {
  it("each page gets the silhouette of its own layout", () => {
    expect(skeletonFor({ view: "inbox" })).toBe("list");
    expect(skeletonFor({ view: "tasks" }, "board")).toBe("board");
    expect(skeletonFor({ view: "project", projectId: "p", tab: "calendar" })).toBe("month");
    expect(skeletonFor({ view: "project", projectId: "p", tab: "docs" })).toBe("list");
    expect(skeletonFor({ view: "projects" })).toBe("tiles");
    expect(skeletonFor({ view: "pulse" })).toBe("insights");
    expect(skeletonFor({ view: "team" })).toBe("people");
    expect(skeletonFor({ view: "myweek" })).toBe("week");
    expect(skeletonFor({ view: "calendar" })).toBe("month");
  });

  it("says what's loading, and hides the silhouette from assistive tech", () => {
    for (const kind of ["list", "board", "tiles", "insights", "people", "week", "month"] as const) {
      const { container, unmount } = render(<PlaceSkeleton kind={kind} label="Inbox" />);
      expect(screen.getByRole("status")).toHaveTextContent("Loading Inbox…");
      const art = container.querySelector(".kpskel > [aria-hidden='true']");
      expect(art, kind).not.toBeNull();
      expect(art!.querySelectorAll(".skel").length, kind).toBeGreaterThan(3);
      unmount();
    }
    render(<PanelSkeleton mobile />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading task…");
    expect(document.querySelector(".kpanel-skel")).toHaveAttribute("data-mobile", "true");
  });
});

describe("build chunks", () => {
  it("puts each vendor in its own long-lived chunk, and leaves the app's code alone", () => {
    const nm = (p: string) => `/repo/node_modules/${p}/index.js`;
    expect(vendorChunk(nm("react"))).toBe("react");
    expect(vendorChunk(nm("react-dom") + "/client.js")).toBe("react");
    expect(vendorChunk(nm("scheduler"))).toBe("react");
    expect(vendorChunk("\0commonjsHelpers.js")).toBe("react");
    expect(vendorChunk(nm("@supabase/auth-js"))).toBe("supabase");
    expect(vendorChunk(nm("@supabase/supabase-js"))).toBe("supabase");
    expect(vendorChunk(nm("@sentry/react"))).toBe("sentry");
    expect(vendorChunk(nm("@sentry-internal/replay"))).toBe("sentry");
    expect(vendorChunk("C:\\repo\\node_modules\\react\\index.js")).toBe("react");
    expect(vendorChunk(nm("left-pad"))).toBe("vendor");
    expect(vendorChunk("/repo/src/App.tsx")).toBeUndefined();
    expect(vendorChunk("/repo/src/lib/supabase.ts")).toBeUndefined();
  });

  it("keeps the stylesheets' order: the components' sheets, then kanbo.css", () => {
    const sheets = main(mainSrc);
    expect(sheets.indexOf("./styles/globalSheets")).toBeGreaterThan(-1);
    expect(sheets.indexOf("./styles/globalSheets")).toBeLessThan(sheets.indexOf("./styles/kanbo.css"));
    // the order they had in the one stylesheet before the app was split
    expect(main(sheetsSrc)).toEqual([
      "../components/integrations/slack.css", "../components/integrations/calendarFeed.css", "../components/integrations/calendarAccounts.css",
      "../components/integrations/push.css", "../components/integrations/publicLink.css", "../components/teamTemplates.css",
      "../components/project/projects.css", "../components/tasks/taskViews.css", "../components/approvals/approvals.css",
      "../auth/googleButton.css", "../components/admin/systemStatus.css",
    ]);
  });
});

/** the bare `import "…"` lines of a module, in order */
function main(src: string): string[] {
  return [...src.matchAll(/^import "([^"]+)";$/gm)].map((m) => m[1]);
}
