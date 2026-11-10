/* lib/portfolioDraft (0054): a portfolio read in the brief's voice, the update Kanbo drafts on this device from its
   projects' latest updates, the facts its AI draft is written from, and the CSV. The clock is pinned. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { draftPortfolioLocal, portfolioCsv, portfolioFactsForAi, portfolioFileName, portfolioSentence, rowBucket, type PortfolioRowLike } from "./portfolioDraft";
import { mergedStatus } from "./honestStatus";
import { indexTasks } from "./statusDraft";
import type { Project, StatusUpdate, Task } from "../data/types";
import type { UpdateFreshness } from "./updateRhythm";

const TODAY = new Date(2026, 10, 10);   // Tue 10 Nov 2026
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(2026, 10, 10, 9, 0)); });
afterEach(() => vi.useRealTimers());

const project = (id: string, name: string): Project => ({ id, name, emoji: "📁", color: "oklch(0.7 0.1 200)", workspaceId: "ws", ownerId: "u-sana" });
const task = (id: string, projectId: string, over: Partial<Task> = {}): Task => ({
  id, title: `Task ${id}`, description: "", status: "todo", priority: "medium", projectId, assigneeId: "", tags: [], dependencies: [], subtasks: [],
  focusMin: 0, comments: 0, aiScore: 0, ...over,
} as Task);
const ok: UpdateFreshness = { kind: "ok", text: "Updated 2d ago", short: "2d", rank: 3, byDay: true, title: "" } as UpdateFreshness;
const missing: UpdateFreshness = { kind: "missing", text: "Update missing", short: "Missing", tone: "warn", rank: 0, byDay: true, title: "" } as UpdateFreshness;
const update = (projectId: string, status: StatusUpdate["status"], daysAgo: number, summary: string, sections?: StatusUpdate["sections"]): StatusUpdate => ({
  id: `su-${projectId}`, projectId, status, summary, createdAt: new Date(2026, 10, 10 - daysAgo, 12).toISOString(), workspaceId: "ws", authorId: "u-sana", ...(sections ? { sections } : {}),
});
const row = (p: Project, latest: StatusUpdate | undefined, fresh = ok, health: "on_track" | "at_risk" | "off_track" = "on_track"): PortfolioRowLike => ({
  p, ptasks: [], health: null, latest, fresh, status: mergedStatus(p, latest, { health, overdue: health === "on_track" ? 0 : 2, blocked: 0 }),
});

const launch = project("p1", "Launch"), brand = project("p2", "Brand"), infra = project("p3", "Infra"), fit = project("p4", "Fit-out"), web = project("p5", "Website"), app = project("p6", "App");

describe("the portfolio's sentence", () => {
  it("counts each project once: its lead's call, or silent when its update is missing", () => {
    const rows = [
      row(launch, update("p1", "on_track", 2, "Moving.")), row(brand, update("p2", "on_track", 3, "Fine.")), row(web, update("p5", "on_track", 1, "Fine.")),
      row(app, update("p6", "on_track", 4, "Fine.")), row(infra, update("p3", "at_risk", 5, "Late.")), row(fit, update("p4", "on_track", 21, "Old news."), missing),
    ];
    expect(portfolioSentence(rows, TODAY)).toBe("6 projects: 4 on track, 1 at risk, 1 silent for 3 weeks");
    expect(rowBucket(rows[5])).toBe("silent");
  });
  it("names a project that has never posted, and an empty portfolio", () => {
    expect(portfolioSentence([row(launch, update("p1", "off_track", 1, "Slipping.")), row(infra, undefined, missing)], TODAY))
      .toBe("2 projects: 1 off track, 1 with no update yet");
    expect(portfolioSentence([], TODAY)).toBe("No projects in it yet.");
  });
  it("a project nobody's updated counts as no update yet (as its pill says), whatever Kanbo reads in the work", () => {
    const rows = [row(launch, update("p1", "on_track", 1, "Fine.")), row(infra, undefined, ok, "on_track"), row(app, undefined, missing), row(web, undefined, ok, "off_track")];
    expect(portfolioSentence(rows, TODAY)).toBe("4 projects: 1 on track, 3 with no update yet");
    expect(rows.map(rowBucket)).toEqual(["on_track", "none", "silent", "none"]);
  });
});

describe("Kanbo's draft, on this device", () => {
  it("leads with how many are on track, names the worst off and why, and the quiet one; gathers the sections", () => {
    const tasks = [task("m1", "p1", { isMilestone: true, dueDate: "2026-11-18", title: "Launch day" })];
    const rows = [
      row(launch, update("p1", "at_risk", 2, "The deck is two weeks late. The rest is fine.", { risks: "The deck slips.", asks: "Approve the budget" }), ok, "at_risk"),
      row(brand, update("p2", "on_track", 3, "Palette shipped.", { highlights: "The new palette is live." })),
      row(infra, update("p3", "on_track", 20, "Old."), missing),
    ];
    const d = draftPortfolioLocal(rows, tasks, indexTasks(tasks), [], TODAY);
    expect(d.summary).toBe("1 of 3 projects is on track. Launch is at risk: the deck is two weeks late. Infra hasn't posted an update for 2 weeks.");
    expect(d.status).toBe("at_risk");
    expect(d.sections).toEqual({
      highlights: "Brand: The new palette is live.",
      risks: "Launch: The deck slips.\nInfra: no update since Wed 21 Oct.",
      asks: "Launch: Approve the budget",
      next: "Launch: Launch day, Wed 18 Nov.",
    });
  });
  it("leaves out an Ask a project put to the portfolio's own owner; names a project with no update while Kanbo sees trouble", () => {
    const asksSana = { ...update("p2", "on_track", 3, "Palette shipped.", { asks: "Sana, can you approve the palette?" }), askUserIds: ["u-sana"] };
    const rows = [row(brand, asksSana), row(launch, update("p1", "on_track", 1, "Fine.", { asks: "Book the venue" })), row(web, undefined, ok, "off_track")];
    const d = draftPortfolioLocal(rows, [], indexTasks([]), [], TODAY, "u-sana");
    expect(d.sections.asks).toBe("Launch: Book the venue");
    expect(d.sections.risks).toBe("Website: no update yet; 2 overdue.");
    expect(draftPortfolioLocal(rows, [], indexTasks([]), [], TODAY).sections.asks).toBe("Brand: Sana, can you approve the palette?\nLaunch: Book the venue");
  });
  it("all on track reads on track; an empty portfolio says so", () => {
    expect(draftPortfolioLocal([row(brand, update("p2", "on_track", 1, "Fine."))], [], indexTasks([]), [], TODAY))
      .toMatchObject({ summary: "1 of 1 project is on track.", status: "on_track" });
    expect(draftPortfolioLocal([], [], indexTasks([]), [], TODAY).summary).toBe("No projects in this portfolio yet.");
  });
  it("the AI's facts: names, calls, counts and each latest update (bounded), never whole tasks", () => {
    const rows = [row(launch, update("p1", "at_risk", 2, "x".repeat(900), { asks: "Approve" }), ok, "at_risk")];
    const f = portfolioFactsForAi({ name: "Q3", description: "All of it", targetDate: "2026-12-18" }, rows, [], indexTasks([]), [], TODAY);
    expect(f).toMatchObject({ portfolio: "Q3", targetDate: "2026-12-18", today: "2026-11-10" });
    expect(f.projects[0]).toMatchObject({ name: "Launch", call: "at_risk", kanbo: "at_risk", updateMissing: false, latest: { daysAgo: 2, status: "at_risk", sections: { asks: "Approve" } } });
    expect(f.projects[0].latest!.summary).toHaveLength(400);
  });
});

describe("export", () => {
  it("one CSV row per project, its business when it spans several", () => {
    const rows = [row(launch, update("p1", "at_risk", 2, "Late, \"badly\".", { risks: "Deck" }), ok, "at_risk")];
    const csv = portfolioCsv(rows, [], indexTasks([]), [], TODAY, { ownerName: () => "Sana Rao", workspaces: [{ id: "ws", name: "Foundrise", kind: "team" }] });
    // (Excel-friendly: a byte-order mark, every cell quoted)
    const [head, line] = csv.replace(/^\ufeff/, "").split(/\r?\n/);
    const q = (cells: string[]) => cells.map((c) => `"${c}"`).join(",");
    expect(head).toBe(q(["Project", "Business", "Owner", "Status", "Kanbo sees", "Done %", "Tasks", "Overdue", "Blocked", "Next milestone", "Milestone date", "Last update", "Update", "Sections", "Update day"]));
    expect(line).toContain(q(["Launch", "Foundrise", "Sana Rao", "At risk", "2 overdue", "0", "0", "0", "0", "", "", "2026-11-08"]));
    expect(line).toContain('"Late, ""badly""."');
    expect(line).toContain('"Risks: Deck"');
    expect(portfolioFileName("Q3 launch!", TODAY, "csv")).toBe("q3-launch-portfolio-2026-11-10.csv");
  });
});
