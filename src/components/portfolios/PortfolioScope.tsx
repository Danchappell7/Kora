/* ============================================================
   KANBO — Insights for one portfolio (0054). Team › Insights (Overview
   and Trends) can be narrowed to a portfolio's projects: a quiet
   "Portfolio" picker above the page, remembered for the session per
   workspace, and set by a portfolio's page ("See in Insights"). Only
   offered while the workspace has portfolios.
   ============================================================ */
import { useState, type ReactNode } from "react";
import type { Portfolio, Project, Task } from "../../data/types";
import "./portfolio.css";

const key = (ws: string | null) => `kanbo-insights-portfolio:${ws ?? "personal"}`;
const read = (ws: string | null): string => { try { return sessionStorage.getItem(key(ws)) ?? ""; } catch { return ""; } };

/** Remember which portfolio Insights shows for a workspace ("" all projects). */
export function setInsightsPortfolio(ws: string | null, portfolioId: string): void {
  try { if (portfolioId) sessionStorage.setItem(key(ws), portfolioId); else sessionStorage.removeItem(key(ws)); } catch { /* private mode */ }
}

/** The tasks and projects of one portfolio (all of them without one). */
export function scopeToPortfolio<T extends Pick<Task, "projectId">, P extends Pick<Project, "id">>(tasks: T[], projects: P[], pf: Pick<Portfolio, "projectIds"> | undefined): { tasks: T[]; projects: P[] } {
  if (!pf) return { tasks, projects };
  const ids = new Set(pf.projectIds);
  return { tasks: tasks.filter((t) => ids.has(t.projectId)), projects: projects.filter((p) => ids.has(p.id)) };
}

export function PortfolioScope<T extends Pick<Task, "projectId">, P extends Pick<Project, "id">>({ workspaceId, portfolios, tasks, projects, children }: {
  workspaceId: string | null;
  /** this workspace's portfolios */
  portfolios: Portfolio[];
  tasks: T[];
  projects: P[];
  children: (tasks: T[], projects: P[], portfolio: Portfolio | undefined) => ReactNode;
}) {
  const [id, setId] = useState(() => read(workspaceId));
  const pf = portfolios.find((p) => p.id === id);
  const scoped = scopeToPortfolio(tasks, projects, pf);
  const pick = (v: string) => { setId(v); setInsightsPortfolio(workspaceId, v); };
  return (
    <>
      {portfolios.length > 0 && (
        <div className="kpf-scope">
          <label className="kpf-scope-in">
            <span>Portfolio</span>
            <select className="kpj-field" data-size="sm" value={pf ? pf.id : ""} onChange={(e) => pick(e.target.value)} aria-label="Show Insights for a portfolio">
              <option value="">All projects</option>
              {portfolios.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          {pf && <span className="kpf-scope-note">{pf.projectIds.length === 1 ? "1 project" : `${scoped.projects.length} projects`} in {pf.name}</span>}
        </div>
      )}
      {children(scoped.tasks, scoped.projects, pf)}
    </>
  );
}
