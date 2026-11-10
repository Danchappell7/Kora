/* ============================================================
   KANBO — project and portfolio updates in the Inbox (0054, kind
   "update", no task). The database writes them: an update posted on
   a project you own or work on (FYI), one whose Ask names you or a
   reply that @mentions you ("Needs your reply"), a reply on your own
   update (FYI), and a portfolio update for its owner and followers.
   Each opens where it lives: the project's Updates tab (its replies
   open), or the portfolio's page. Pure: no React, no I/O.
   ============================================================ */
import type { Activity, Portfolio, Project } from "../data/types";
import type { Route } from "../app-types";

/** Does it ask something of you? (an Ask that names you, or a reply that mentions you) */
export const isUpdateAsk = (a: Pick<Activity, "kind" | "meta">): boolean => a.kind === "update" && !!a.meta?.ask;

/** "posted an update on" · "asked you something in the update on" · "replied to your update on" … */
export function updateVerb(a: Pick<Activity, "meta">): string {
  const m = a.meta ?? {};
  switch (m.updateEvent) {
    case "asked": return "asked you something in the update on";
    case "comment": return m.ask ? "mentioned you in a reply on the update on" : "replied to your update on";
    case "portfolio": return "posted a portfolio update on";
    default: return m.ask ? "asked you something in the update on" : "posted an update on";
  }
}

/** Where it opens: the project's Updates tab, or the portfolio's page. Null when it can't say. */
export function updateItemRoute(a: Pick<Activity, "kind" | "meta">): Route | null {
  if (a.kind !== "update") return null;
  if (a.meta?.portfolioId) return { view: "portfolios", portfolioId: a.meta.portfolioId, tab: "updates" };
  return a.meta?.projectId ? { view: "project", projectId: a.meta.projectId, tab: "updates" } : null;
}

/** The workspace an update item belongs to: its project's (or portfolio's). Undefined when it can't be told. */
export function updateItemWorkspace(a: Pick<Activity, "kind" | "meta">, projects: readonly Pick<Project, "id" | "workspaceId">[],
  portfolios: readonly Pick<Portfolio, "id" | "workspaceId">[] = []): string | null | undefined {
  if (a.kind !== "update") return undefined;
  if (a.meta?.portfolioId) {
    const pf = portfolios.find((x) => x.id === a.meta!.portfolioId);
    return pf ? pf.workspaceId ?? null : undefined;
  }
  const p = a.meta?.projectId ? projects.find((x) => x.id === a.meta!.projectId) : undefined;
  return p ? p.workspaceId ?? null : undefined;
}
