/* A Personal portfolio across businesses: the picker lists every business's projects under its logo,
   cards and the table read every workspace's work, a project you can no longer see says so (and can
   be taken out), and the card says only you can see it. A workspace's own portfolio is as it was. */
import { describe, it, expect, vi } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import { PortfoliosView } from "./GoalsPortfolios";
import { PROJECTS, TASKS, WORKSPACES } from "../../data/data";
import type { Portfolio, Task } from "../../data/types";

const live = PROJECTS.filter((p) => !p.archivedAt);
const tasks: Task[] = TASKS.map((t) => ({ ...t, workspaceId: PROJECTS.find((p) => p.id === t.projectId)?.workspaceId ?? null }));
const personal: Portfolio = { id: "pf-x", name: "Every opening", projectIds: ["p-launch", "p-clubhouse", "p-gone"], workspaceId: null };

const renderPf = (o: Partial<React.ComponentProps<typeof PortfoliosView>> = {}) => {
  const onUpdate = vi.fn();
  const onOpenProject = vi.fn();
  render(<PortfoliosView portfolios={[personal]} projects={live} tasks={tasks} onCreate={vi.fn()} onUpdate={onUpdate} onDelete={vi.fn()} onOpenProject={onOpenProject}
    acrossBusinesses={{ workspaces: WORKSPACES }} {...o} />);
  return { onUpdate, onOpenProject };
};

describe("PortfoliosView · in Personal, across businesses", () => {
  it("says only you can see it, and each project says which business it's from", () => {
    try { localStorage.removeItem("kanbo-portfolio-view"); } catch { /* ignore */ }
    renderPf();
    const card = screen.getByRole("article", { name: "Portfolio Every opening" });
    expect(within(card).getByText("Only you can see this")).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Open project Q3 Product Launch" })).toBeInTheDocument();
    expect(within(card).getByText("Foundrise")).toBeInTheDocument();
    expect(within(card).getByText("Courtside Padel")).toBeInTheDocument();
    // its progress counts every business's work it holds: two projects, not three
    expect(within(card).getByText(/· 2 projects/)).toBeInTheDocument();
  });

  it("a project you can no longer see keeps its place, says so, and can be taken out", () => {
    const { onUpdate } = renderPf();
    expect(screen.getByText("No longer visible to you")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove the project you can no longer see from Every opening" }));
    expect(onUpdate).toHaveBeenCalledWith("pf-x", { projectIds: ["p-launch", "p-clubhouse"] });
  });

  it("the picker lists every business's projects under its name", () => {
    const { onUpdate } = renderPf();
    fireEvent.click(screen.getByRole("button", { name: "Add a project to Every opening" }));
    const picker = screen.getByRole("group", { name: "Projects you can add to Every opening" });
    const groups = within(picker).getAllByRole("group").map((g) => g.getAttribute("aria-label"));
    expect(groups).toEqual(["Foundrise", "Reco HQ", "Courtside Padel", "Harbour Advisory"]);
    expect(within(within(picker).getByRole("group", { name: "Reco HQ" })).getByRole("button", { name: "Add Customer Onboarding to Every opening" })).toBeInTheDocument();
    // what's already in it isn't offered
    expect(within(picker).queryByRole("button", { name: "Add Clubhouse Fit-out to Every opening" })).toBeNull();
    fireEvent.click(within(picker).getByRole("button", { name: "Add Winter League to Every opening" }));
    expect(onUpdate).toHaveBeenCalledWith("pf-x", { projectIds: ["p-launch", "p-clubhouse", "p-gone", "p-league"] });
  });

  it("the exec table reads every business too, the unseen project last", () => {
    renderPf();
    fireEvent.click(screen.getByRole("button", { name: "Table" }));
    const table = screen.getByRole("table", { name: "Every opening projects" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((r) => r.textContent?.slice(0, 24))).toEqual([
      expect.stringContaining("Q3 Product Launch"), expect.stringContaining("Clubhouse Fit-out"), expect.stringContaining("No longer visible to you"),
    ]);
    expect(within(rows[1]).getByText("Courtside Padel")).toBeInTheDocument();
    // the unseen one fills the table's columns like the rest: why under Latest update, remove at the end
    const cells = within(rows[2]).getAllByRole("cell");
    expect(cells).toHaveLength(5);
    expect(cells[1]).toHaveTextContent("You've lost access to it, or it was deleted");
    expect(within(cells[4]).getByRole("button", { name: /^Remove the project you can no longer see/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cards" }));
  });

  it("a workspace's own portfolio is as it was: this workspace's projects, nothing about who can see it", () => {
    const team: Portfolio = { id: "pf-t", name: "Q3", projectIds: ["p-launch", "p-gone"], workspaceId: "ws-foundrise" };
    renderPf({ portfolios: [team], projects: live.filter((p) => p.workspaceId === "ws-foundrise"), acrossBusinesses: undefined });
    expect(screen.queryByText("Only you can see this")).toBeNull();
    expect(screen.queryByText("No longer visible to you")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add a project to Q3" }));
    expect(screen.queryByRole("button", { name: "Add Winter League to Q3" })).toBeNull();
  });
});
