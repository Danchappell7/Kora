/* Portfolios with honest status and update days (0053): ONE pill per project (the lead's call, marked when
   Kanbo sees worse, "Lead says / Kanbo sees" on hover and focus), those mismatches first; "Update missing"
   past a project's day, with Ask for an update for the workspace's leads. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import type { Portfolio, Project, StatusUpdate, Task } from "../../data/types";
import { refreshClock } from "../../data/data";
import { noteRhythmSchema, resetRhythmSchema } from "../../lib/updateRhythm";
import type { AskForUpdate } from "../../lib/updateAsks";
import { PortfoliosView } from "./PortfoliosView";

const NOW = new Date(2026, 10, 13, 10);      // Friday 13 Nov 2026: the team's day (the default)
const proj = (id: string, name: string, o: Partial<Project> = {}): Project => ({ id, name, emoji: "", color: "red", workspaceId: "ws", ownerId: "m-2", ...o });
const task = (id: string, projectId: string, o: Partial<Task> = {}): Task => ({
  id, title: id, description: "", status: "todo", priority: "medium", projectId, assigneeId: "m-2", tags: [], dependencies: [], subtasks: [],
  focusMin: 30, comments: 0, aiScore: 0, createdAt: "2026-10-01T09:00:00", ...o,
});
const upd = (projectId: string, status: StatusUpdate["status"], createdAt: string, summary = "…"): StatusUpdate => ({ id: `u-${projectId}`, projectId, status, summary, createdAt, authorId: "m-2" });

// Calm says On track and is; Rosy says On track with two overdue; Quiet hasn't posted since last round
const projects = [proj("calm", "Calm"), proj("rosy", "Rosy"), proj("quiet", "Quiet")];
const tasks = [
  task("c1", "calm"),
  task("r1", "rosy", { dueDate: "2026-11-02" }), task("r2", "rosy", { dueDate: "2026-11-03" }), task("r3", "rosy"), task("r4", "rosy"), task("r5", "rosy"), task("r6", "rosy"), task("r7", "rosy"), task("r8", "rosy"),
  task("q1", "quiet"),
];
const updates = [upd("calm", "on_track", "2026-11-12T10:00:00"), upd("rosy", "on_track", "2026-11-12T11:00:00", "All fine"), upd("quiet", "on_track", "2026-10-20T10:00:00")];
const pf: Portfolio = { id: "pf", name: "Q4", projectIds: ["calm", "rosy", "quiet"] };
const base = { portfolios: [pf], projects, tasks, statusUpdates: updates, onCreate: vi.fn(), onUpdate: vi.fn(), onDelete: vi.fn(), onOpenProject: vi.fn() };
const asks = (): AskForUpdate => ({ canAsk: () => true, asked: () => undefined, ask: vi.fn(async () => ({}) as never) });

beforeEach(() => { localStorage.clear(); noteRhythmSchema(true); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); refreshClock(NOW); });
afterEach(() => { vi.useRealTimers(); refreshClock(new Date()); resetRhythmSchema(); });

describe("PortfoliosView: one pill, mismatches first", () => {
  it("cards: one pill per project, the rosy one first and marked, Lead says / Kanbo sees on it", () => {
    render(<PortfoliosView {...base} />);
    const card = screen.getByRole("article", { name: "Portfolio Q4" });
    const names = within(card).getAllByRole("button", { name: /^Open project / }).map((b) => b.textContent);
    // (the rest keep the order they were added in)
    expect(names).toEqual(["Rosy", "Calm", "Quiet"]);
    const rosy = within(card).getAllByRole("img", { name: /^On track\. Lead says On track · Kanbo sees 2 overdue/ });
    expect(rosy).toHaveLength(1);
    expect(rosy[0]).toHaveAttribute("data-mismatch", "true");
    expect(rosy[0].getAttribute("data-tip")).toContain("Latest update (Thu 12 Nov, Theo Vance): All fine");
    // (no second "Update:" pill beside it any more)
    expect(within(card).queryByText(/^Update: /)).toBeNull();
  });

  it("table: the same pill and order, and a missing update says so with Ask for an update", () => {
    localStorage.setItem("kanbo-portfolio-view", "table");
    const a = asks();
    render(<PortfoliosView {...base} asks={a} />);
    const rows = within(screen.getByRole("table", { name: "Q4 projects" })).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getByRole("button", { name: /^Open project / }).textContent)).toEqual(["Rosy", "Calm", "Quiet"]);
    expect(within(rows[2]).getByText("Update missing")).toHaveAttribute("title", "Last update 24 days ago. None came in last round, and one is due today.");
    fireEvent.click(within(rows[2]).getByRole("button", { name: /for an update on Quiet$/ }));
    expect(a.ask).toHaveBeenCalledWith(expect.objectContaining({ id: "quiet" }));
    // fresh ones just say how fresh, and aren't asked about
    expect(within(rows[1]).queryByRole("button", { name: /for an update/ })).toBeNull();
    expect(screen.getByText("1 update missing")).toBeInTheDocument();
  });

  it("a guest reads the pills and the missing word, and is never offered Ask", () => {
    localStorage.setItem("kanbo-portfolio-view", "table");
    render(<PortfoliosView {...base} asks={asks()} readOnly />);
    expect(screen.getByText("Update missing")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /for an update/ })).toBeNull();
  });

  it("On hold is the lead's call: never a mismatch, and its update isn't chased", () => {
    localStorage.setItem("kanbo-portfolio-view", "table");
    render(<PortfoliosView {...base} statusUpdates={[...updates.filter((u) => u.projectId !== "quiet"), upd("quiet", "on_hold", "2026-10-20T10:00:00")]} asks={asks()} />);
    const quiet = screen.getByRole("button", { name: "Open project Quiet" }).closest("[role=row]") as HTMLElement;
    expect(within(quiet).getByRole("img", { name: /^On hold\./ })).not.toHaveAttribute("data-mismatch");
    expect(within(quiet).queryByText("Update missing")).toBeNull();
  });
});
