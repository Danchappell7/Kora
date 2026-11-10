/* A portfolio's own page (0054): its sentence in the brief's voice, owner · target date · followers, Table and Updates,
   adding several projects at once, CSV and Print, the update Kanbo drafts for its owner (and its AI's), and what a
   reader without write access, a Personal portfolio and a database without 0054 see. The clock is pinned. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, fireEvent, act } from "@testing-library/react";
import type { Portfolio, Project, StatusUpdate, Task } from "../../data/types";
import { refreshClock } from "../../data/data";
import { noteRhythmSchema, resetRhythmSchema } from "../../lib/updateRhythm";
import { resetPortfolioUpdates } from "../../lib/portfolioUpdates";
import * as exportTasks from "../../lib/exportTasks";
import { PortfolioPage } from "./PortfolioPage";
import { PortfolioScope, scopeToPortfolio, setInsightsPortfolio } from "./PortfolioScope";

const NOW = new Date(2026, 10, 13, 10);      // Friday 13 Nov 2026: the team's day (the default)
const proj = (id: string, name: string, o: Partial<Project> = {}): Project => ({ id, name, emoji: "📁", color: "red", workspaceId: "ws", ownerId: "m-2", ...o });
const task = (id: string, projectId: string, o: Partial<Task> = {}): Task => ({
  id, title: id, description: "", status: "todo", priority: "medium", projectId, assigneeId: "m-2", tags: [], dependencies: [], subtasks: [],
  focusMin: 30, comments: 0, aiScore: 0, createdAt: "2026-10-01T09:00:00", ...o,
});
const upd = (projectId: string, status: StatusUpdate["status"], createdAt: string, summary = "…"): StatusUpdate => ({ id: `u-${projectId}`, projectId, status, summary, createdAt, authorId: "m-2" });
const projects = [proj("calm", "Calm"), proj("risky", "Risky"), proj("quiet", "Quiet"), proj("spare", "Spare"), proj("other", "Other")];
const tasks = [task("c1", "calm"), task("r1", "risky"), task("q1", "quiet"), task("s1", "spare")];
const updates = [upd("calm", "on_track", "2026-11-12T10:00:00", "Moving."), upd("risky", "at_risk", "2026-11-11T11:00:00", "The deck is late. More soon."), upd("quiet", "on_track", "2026-10-20T10:00:00")];
const PF: Portfolio = { id: "pf", name: "Q4", projectIds: ["calm", "risky", "quiet"], workspaceId: "ws", ownerId: "m-self", description: "The quarter's bets",
  targetDate: "2026-12-18", followerIds: ["m-1"], color: null, emoji: "🏁" };
const members = [{ id: "m-self", name: "Daniel Okai" }, { id: "m-1", name: "Maya Lin" }, { id: "m-2", name: "Theo Vance" }];
const page = (o: Partial<React.ComponentProps<typeof PortfolioPage>> = {}) => {
  const props: React.ComponentProps<typeof PortfolioPage> = {
    portfolio: PF, projects, tasks, statusUpdates: updates, members, me: "m-self", tab: "table", onTab: vi.fn(), onBack: vi.fn(), onUpdate: vi.fn(), onDelete: vi.fn(),
    onOpenProject: vi.fn(), ...o,
  };
  return { ...render(<PortfolioPage {...props} />), props };
};

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); noteRhythmSchema(true); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); refreshClock(NOW); resetPortfolioUpdates(); });
afterEach(() => { vi.useRealTimers(); refreshClock(new Date()); resetRhythmSchema(); vi.restoreAllMocks(); });

describe("a portfolio's page", () => {
  it("says how the programme is going in one sentence, then owner, target date and followers", () => {
    page();
    expect(screen.getByText("3 projects: 1 on track, 1 at risk, 1 silent for 3 weeks.")).toBeInTheDocument();
    expect(screen.getByText(/0% of the work is done, and it's due to land Fri 18 Dec/)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Portfolio owner" })).toHaveValue("m-self");
    expect(screen.getByRole("button", { name: /^Target date: Fri 18 Dec/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Follow" })).toBeInTheDocument();
  });

  it("writers change the owner, follow it, choose followers and set its description", () => {
    const { props } = page();
    fireEvent.change(screen.getByRole("combobox", { name: "Portfolio owner" }), { target: { value: "m-1" } });
    expect(props.onUpdate).toHaveBeenCalledWith("pf", { ownerId: "m-1" });
    fireEvent.click(screen.getByRole("button", { name: "Follow" }));
    expect(props.onUpdate).toHaveBeenCalledWith("pf", { followerIds: ["m-1", "m-self"] });
    fireEvent.click(screen.getByRole("button", { name: "Choose followers" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Who follows this portfolio" })).getByRole("button", { name: "Theo" }));
    expect(props.onUpdate).toHaveBeenCalledWith("pf", { followerIds: ["m-1", "m-2"] });
  });

  it("Table: one row per project; several projects are added at once", () => {
    const { props } = page();
    const rows = within(screen.getByRole("table", { name: "Q4 projects" })).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Projects" }));
    const picker = screen.getByRole("group", { name: "Add projects to Q4" });
    fireEvent.click(within(picker).getByRole("button", { name: "Spare" }));
    fireEvent.click(within(picker).getByRole("button", { name: "Other" }));
    fireEvent.click(within(picker).getByRole("button", { name: "Add 2 projects" }));
    expect(props.onUpdate).toHaveBeenCalledWith("pf", { projectIds: ["calm", "risky", "quiet", "spare", "other"] });
  });

  it("exports the table as CSV, and opens a clean page to print or save as PDF", () => {
    const dl = vi.spyOn(exportTasks, "downloadCsv").mockImplementation(() => undefined);
    const doc = { write: vi.fn(), close: vi.fn() };
    const open = vi.spyOn(window, "open").mockReturnValue({ document: doc, focus: vi.fn(), print: vi.fn() } as unknown as Window);
    page();
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(dl).toHaveBeenCalledWith("q4-portfolio-2026-11-13.csv", expect.stringContaining("\"Risky\""));
    fireEvent.click(screen.getByRole("button", { name: "Print or PDF" }));
    expect(open).toHaveBeenCalled();
    expect(doc.write.mock.calls[0][0]).toContain("3 projects: 1 on track, 1 at risk, 1 silent for 3 weeks");
  });

  it("Updates: the owner opens to Kanbo's draft from the projects' latest updates, and posts it", async () => {
    page({ tab: "updates" });
    const box = screen.getByRole("textbox", { name: "Portfolio update" }) as HTMLTextAreaElement;
    expect(box.value).toBe("1 of 3 projects is on track. Risky is at risk: the deck is late. Quiet hasn't posted an update for 3 weeks.");
    expect(screen.getByRole("button", { name: "At risk" })).toHaveAttribute("aria-pressed", "true");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Post update" })); });
    const history = screen.getByRole("list", { name: "Earlier portfolio updates" });
    expect(within(history).getByText(/^1 of 3 projects is on track/)).toBeInTheDocument();
    // and each project's latest underneath
    const latest = within(screen.getByRole("region", { name: "Each project's latest update" }));
    expect(latest.getByText("The deck is late. More soon.")).toBeInTheDocument();
    // posted: the composer folds back to its button, rather than stay open and empty
    expect(screen.queryByRole("textbox", { name: "Portfolio update" })).toBeNull();
    expect(screen.getByRole("button", { name: "Draft a portfolio update" })).toBeInTheDocument();
  });

  it("Updates: the owner's composer says once where its draft came from", () => {
    page({ tab: "updates" });
    expect(screen.getAllByText(/drafted this|Drafted on this device/)).toHaveLength(1);
    expect(screen.getByText("Kanbo drafted this on this device from the projects' latest updates. Edit it, then post it for your followers.")).toBeInTheDocument();
  });

  it("Print or PDF puts its latest portfolio update at the top, the thing a meeting most wants", async () => {
    const doc = { write: vi.fn(), close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue({ document: doc, focus: vi.fn(), print: vi.fn() } as unknown as Window);
    page({ tab: "updates" });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Post update" })); });
    fireEvent.click(screen.getByRole("button", { name: "Print or PDF" }));
    expect(doc.write.mock.calls[0][0]).toMatch(/Latest portfolio update · At risk · .*1 of 3 projects is on track/);
  });

  it("adding projects: Escape or another tab puts the picker away; with nothing left to add, the button says so", () => {
    const { props } = page();
    fireEvent.click(screen.getByRole("button", { name: "Projects" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Spare" }), { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Add projects to Q4" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Projects" }));
    fireEvent.click(screen.getByRole("button", { name: "Updates" }));
    expect(props.onTab).toHaveBeenCalledWith("updates");
    expect(screen.queryByRole("group", { name: "Add projects to Q4" })).toBeNull();
  });

  it("a portfolio just made (still on its way to the database) already offers its owner, date and followers", () => {
    const { followerIds: _f, ownerId: _o, description: _d, targetDate: _t, ...bare } = PF;
    page({ portfolio: { ...bare, id: "tmp-pf-1" } });
    expect(screen.queryByText(/aren't switched on yet/)).toBeNull();
    expect(screen.getByRole("combobox", { name: "Portfolio owner" })).toBeInTheDocument();
  });

  it("Updates: Kanbo's AI drafts it when it's on (its facts never carry whole tasks)", async () => {
    const ai = vi.fn(async () => ({ source: "ai" as const, data: { summary: "Two of three are moving.", status: "at_risk" as const, sections: { risks: "Risky: the deck." } } }));
    page({ tab: "updates", aiPortfolio: ai });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Redraft/ })); });
    expect(ai).toHaveBeenCalledWith(expect.objectContaining({ portfolio: "Q4", projects: expect.arrayContaining([expect.objectContaining({ name: "Risky", call: "at_risk" })]) }));
    expect(screen.getByRole("textbox", { name: "Portfolio update" })).toHaveValue("Two of three are moving.");
    expect(screen.getByRole("textbox", { name: "Risks" })).toHaveValue("Risky: the deck.");
  });

  it("someone who isn't its owner is offered the draft behind a button; a reader gets no controls", () => {
    const { unmount } = page({ tab: "updates", me: "m-1" });
    expect(screen.queryByRole("textbox", { name: "Portfolio update" })).toBeNull();
    expect(screen.getByRole("button", { name: "Draft a portfolio update" })).toBeInTheDocument();
    unmount();
    page({ readOnly: true });
    expect(screen.queryByRole("combobox", { name: "Portfolio owner" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Projects" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Delete portfolio/ })).toBeNull();
  });

  it("before 0054: no owner, date or followers to set, and it says so", () => {
    const { followerIds: _f, ownerId: _o, description: _d, targetDate: _t, ...old } = PF;
    page({ portfolio: old });
    expect(screen.getByText("An owner, target date and followers aren't switched on yet.")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Portfolio owner" })).toBeNull();
  });

  it("a Personal portfolio across businesses: only you see it, so no owner to pick and no followers", () => {
    page({ portfolio: { ...PF, workspaceId: null }, acrossBusinesses: { workspaces: [{ id: "ws", name: "Foundry", kind: "team" }] } });
    expect(screen.getByText(/only you can see it/)).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Portfolio owner" })).toBeNull();
    expect(screen.queryByText("Followers")).toBeNull();
  });
});

describe("Insights for one portfolio", () => {
  const pfs: Portfolio[] = [{ id: "pf", name: "Q4", projectIds: ["calm"] }, { id: "pf2", name: "Other", projectIds: ["risky"] }];
  it("narrows the tasks and projects to the portfolio's, and remembers the choice for the session", () => {
    expect(scopeToPortfolio(tasks, projects, pfs[0])).toEqual({ tasks: [tasks[0]], projects: [projects[0]] });
    const seen = vi.fn(() => null);
    const { unmount } = render(<PortfolioScope workspaceId="ws" portfolios={pfs} tasks={tasks} projects={projects}>{seen}</PortfolioScope>);
    expect(seen).toHaveBeenLastCalledWith(tasks, projects, undefined);
    fireEvent.change(screen.getByRole("combobox", { name: "Show Insights for a portfolio" }), { target: { value: "pf2" } });
    expect(seen).toHaveBeenLastCalledWith([tasks[1]], [projects[1]], pfs[1]);
    unmount();
    render(<PortfolioScope workspaceId="ws" portfolios={pfs} tasks={tasks} projects={projects}>{seen}</PortfolioScope>);
    expect(screen.getByRole("combobox", { name: "Show Insights for a portfolio" })).toHaveValue("pf2");
  });
  it("a portfolio's page can open Insights on it; nothing's offered without portfolios", () => {
    setInsightsPortfolio("ws", "pf");
    const seen = vi.fn(() => null);
    render(<PortfolioScope workspaceId="ws" portfolios={pfs} tasks={tasks} projects={projects}>{seen}</PortfolioScope>);
    expect(seen).toHaveBeenLastCalledWith([tasks[0]], [projects[0]], pfs[0]);
    const none = render(<PortfolioScope workspaceId="ws2" portfolios={[]} tasks={tasks} projects={projects}>{() => null}</PortfolioScope>);
    expect(none.container.querySelector(".kpf-scope")).toBeNull();
  });
});
