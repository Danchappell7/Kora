import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within, act, waitFor } from "@testing-library/react";
import { NewWorkspaceModal } from "../NewWorkspaceModal";
import { NewProjectModal } from "../NewProjectModal";
import { PackGallery } from "./PackGallery";
import { packContextFor } from "./usePackApply";
import { keyResultTarget } from "./PackPreview";
import { BUSINESS_PACKS, findPack } from "../../packs";
import { buildPackPlan, packPart, type PackPick } from "../../lib/packPlan";
import { applyPackPlan, type PackApplyDeps } from "../../lib/packApply";
import type { PackHost, PackOutcome, PackUiContext } from "./packTypes";
import type { Project, Task, WorkspaceTemplate } from "../../data/types";

const TODAY = new Date(2026, 10, 10);
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(2026, 10, 10, 9, 0)); });
afterEach(() => { vi.useRealTimers(); });

const context = (over: Partial<PackUiContext> = {}): PackUiContext => ({
  mode: "workspace", today: TODAY, goalsV2: true, canSetGoals: true, canSetUpdateDay: true, businesses: [], ...over,
});
let seq = 0;
const nid = (k: string) => `${k}-${++seq}`;
/** What setting a pack up would make, with creates that just hand back what they're given. */
async function outcomeOf(pack: WorkspaceTemplate, pick: PackPick, ctx: PackUiContext): Promise<PackOutcome> {
  const plan = buildPackPlan(pack, pick, ctx);
  const deps: PackApplyDeps = {
    createProject: async (i) => ({ id: nid("p"), name: i.name, emoji: i.emoji, color: i.color, workspaceId: i.workspaceId }) as Project,
    createSection: async (i) => ({ id: nid("s"), projectId: i.projectId, name: i.name }),
    createTasks: async (ts: Task[]) => ts,
    createForm: async (i) => ({ id: nid("f"), projectId: i.projectId, name: i.name, fields: i.fields }),
    createRule: async (i) => ({ id: nid("r"), projectId: i.projectId, name: i.name, trigger: "task_created", actions: i.actions, enabled: true }),
    createDoc: async (i) => ({ id: nid("d"), projectId: i.projectId, title: i.title }),
    createGoal: async (i) => ({ id: nid("g"), name: i.name, status: "on_track", ...i.extra }),
    addGoalLink: async (i) => ({ id: nid("l"), goalId: i.goalId, kind: i.kind, targetId: i.targetId }),
    createPortfolio: async (i) => ({ id: nid("pf"), name: i.name, projectIds: i.projectIds ?? [] }),
    setUpdateRhythm: async () => {},
  };
  const applied = await applyPackPlan(plan, { workspaceId: "ws-new", me: "u-me", rhythmBefore: null }, deps);
  return { pack, plan, applied, workspaceId: "ws-new" };
}
const host = (over: Partial<PackHost> = {}): PackHost => ({
  context: context(), undo: vi.fn(async () => ({ failed: [], binned: true })), printPoster: vi.fn(async () => null), open: vi.fn(), ...over,
});
const named = (name: string) => fireEvent.change(screen.getByRole("textbox", { name: "Workspace name" }), { target: { value: name } });
const card = (name: string) => screen.getByRole("heading", { name }).closest("li")!;
const row = (name: string | RegExp) => screen.getByRole("checkbox", { name });

describe("PackGallery", () => {
  it("shows a card per pack: who it's for, what it does, what's inside, and Preview", () => {
    const onPreview = vi.fn();
    render(<PackGallery onPreview={onPreview} />);
    expect(within(screen.getByRole("list", { name: "Business packs" })).getAllByRole("listitem").filter((li) => li.classList.contains("kbpk-card"))).toHaveLength(6);
    const c = card("Boutique fitness group");
    expect(within(c).getByText("Studios and small fitness groups")).toBeInTheDocument();
    const inside = within(within(c).getByRole("list", { name: "What's in Boutique fitness group" }));
    expect(inside.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["5 projects", "3 goals", "1 portfolio", "4 docs", "QR request form", "Updates every Monday"]);
    expect(within(card("Holding company")).getByText("3 projects, and one for each business")).toBeInTheDocument();
    expect(within(card("Holding company")).getByText("Updates on the last Friday of the month")).toBeInTheDocument();
    fireEvent.click(within(c).getByRole("button", { name: "Preview" }));
    expect(onPreview).toHaveBeenCalledWith(findPack("pack-fitness"));
  });
});

describe("New workspace › a business pack", () => {
  const toPreview = (h = host()) => {
    const onCreate = vi.fn(async (_name: string, start?: unknown) => {
      const s = start as { pack: WorkspaceTemplate; pick: PackPick };
      return outcomeOf(s.pack, s.pick, h.context);
    });
    const onClose = vi.fn();
    render(<NewWorkspaceModal open onClose={onClose} onCreate={onCreate} packs={h} />);
    named("Acme");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    const setup = screen.getByRole("dialog", { name: "Set up Acme" });
    expect(within(setup).getByRole("list", { name: "Business packs" })).toBeInTheDocument();
    expect(within(setup).getByRole("list", { name: "Team templates" })).toBeInTheDocument();
    fireEvent.click(within(card("Boutique fitness group")).getByRole("button", { name: "Preview" }));
    return { onCreate, onClose, h };
  };

  it("previews everything it sets up: key dates, projects and their tasks, goals, the portfolio, docs, forms and the update day", () => {
    toPreview();
    const sheet = screen.getByRole("dialog", { name: "Boutique fitness group for Acme" });
    expect(within(sheet).getByLabelText("Opening day")).toHaveValue("2027-02-08");
    expect(within(sheet).getByLabelText("New timetable starts")).toHaveValue("2027-01-05");
    expect(row(/New studio opening.*13 tasks · counts back from opening day/)).toBeChecked();
    expect(row(/Studio maintenance.*QR request form · a rule/)).toBeChecked();
    // the opening's tasks, dated back from opening day
    const tasks = within(sheet).getByText("Show 13 tasks").closest("details")!;
    expect(within(tasks).getByText("Opening day").nextSibling).toHaveTextContent("Mon 8 Feb · key date");
    expect(within(tasks).getByText(/^Agree the fit-out plan/).nextSibling).toHaveTextContent("Today");
    // goals for next quarter, owned by you, with their key results
    expect(within(sheet).getByRole("combobox")).toHaveValue("2027-Q1");
    expect(row(/Full classes, every week.*Owned by you/)).toBeChecked();
    expect(within(within(sheet).getByRole("list", { name: "Key results for Full classes, every week" })).getByText("Average class fill").nextSibling).toHaveTextContent("75%");
    expect(row(/Studio growth.*New studio opening, Timetable change, Instructor onboarding/)).toBeChecked();
    expect(row(/Weekly studio meeting.*In Studio routines · meeting notes/)).toBeChecked();
    expect(row(/Report a maintenance problem.*with a QR poster to print/)).toBeChecked();
    expect(row(/Project updates every Monday/)).toBeChecked();
    expect(within(sheet).getByText("5 projects · 34 tasks · 3 goals · 1 portfolio · 4 docs · 1 form")).toBeInTheDocument();
  });

  it("a doc or a form comes with its project: untick the project and they go too", () => {
    toPreview();
    fireEvent.click(row(/^Studio maintenance/));
    const form = row(/Report a maintenance problem/);
    expect(form).not.toBeChecked();
    expect(form).toBeDisabled();
    expect(form).toHaveAccessibleName(/Comes with Studio maintenance, which is unticked/);
    expect(screen.getByText("4 projects · 30 tasks · 3 goals · 1 portfolio · 4 docs")).toBeInTheDocument();
    fireEvent.click(row(/^New studio opening/));
    expect(screen.getByLabelText("Opening day")).toBeDisabled();
    expect(row(/Open the new studio on time/)).toHaveAccessibleName(/New studio opening is unticked/);
  });

  it("a key date that's close says how many tasks start out behind", () => {
    toPreview();
    fireEvent.change(screen.getByLabelText("Opening day"), { target: { value: "2026-12-22" } });
    expect(screen.getByText(/6 tasks would already be behind, so they start out due today/)).toBeInTheDocument();
  });

  it("sets it up with what's ticked, then says what it made; Undo takes it all back", async () => {
    const { onCreate, onClose, h } = toPreview();
    fireEvent.click(row(/^Instructor onboarding/));
    fireEvent.change(screen.getByLabelText("Opening day"), { target: { value: "2027-03-01" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Set up Boutique fitness group" })); });
    expect(onCreate).toHaveBeenCalledTimes(1);
    const [name, start] = onCreate.mock.calls[0] as unknown as [string, { pack: WorkspaceTemplate; pick: PackPick }];
    expect(name).toBe("Acme");
    expect(start.pack).toBe(findPack("pack-fitness"));
    expect(start.pick).toMatchObject({ off: [packPart.project("instructors")], anchors: { opening: "2027-03-01" }, quarter: "2027-Q1" });
    const done = await screen.findByRole("dialog", { name: "Acme is set up" });
    expect(within(done).getByRole("heading", { name: "Boutique fitness group is set up" })).toBeInTheDocument();
    const made = within(within(done).getByRole("list", { name: "What Boutique fitness group set up" }));
    expect(made.getByText("4 projects and 29 starter tasks")).toBeInTheDocument();
    expect(made.getByText("3 goals with 6 key results for Q1 2027")).toBeInTheDocument();
    expect(made.getByText("Updates every Monday")).toBeInTheDocument();
    // Open goes there (the sheet closes first)
    fireEvent.click(made.getByRole("button", { name: /Open 3 goals/ }));
    expect(onClose).toHaveBeenCalled();
    expect(h.open).toHaveBeenCalledWith({ view: "goals", tab: "2027-Q1" });
    // Undo asks first, with what goes (and that a printed poster stops working); Keep it changes nothing
    fireEvent.click(within(done).getByRole("button", { name: "Undo setup" }));
    expect(within(done).getByText(/^Remove 4 projects and 29 starter tasks, 3 goals with 6 key results, .+ and 1 request form\? A QR poster you've printed stops working\.$/)).toBeInTheDocument();
    fireEvent.click(within(done).getByRole("button", { name: "Keep it" }));
    expect(h.undo).not.toHaveBeenCalled();
    fireEvent.click(within(done).getByRole("button", { name: "Undo setup" }));
    await act(async () => { fireEvent.click(within(done).getByRole("button", { name: "Remove it all" })); });
    expect(h.undo).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("heading", { name: "Taken back" })).toBeInTheDocument();
    expect(screen.getByText(/Everything Boutique fitness group set up has been removed\. Deleted projects wait in the recycle bin/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo setup" })).toBeNull();
  });

  it("prints a form's QR poster from the summary, and says why when it can't", async () => {
    const h = host({ printPoster: vi.fn(async () => "Your browser blocked the poster's window. Allow pop-ups for Kanbo, then try again.") });
    toPreview(h);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Set up Boutique fitness group" })); });
    const posters = await screen.findByRole("region", { name: "Print the QR poster" });
    expect(within(posters).getByText("“Something broken?”")).toBeInTheDocument();
    expect(within(posters).getByText(/switches on the form's public link/)).toBeInTheDocument();
    await act(async () => { fireEvent.click(within(posters).getByRole("button", { name: "Print QR poster" })); });
    expect(h.printPoster).toHaveBeenCalledWith(expect.objectContaining({ formName: "Report a maintenance problem", headline: "Something broken?" }), expect.anything());
    expect(await within(posters).findByRole("alert")).toHaveTextContent(/blocked the poster's window/);
  });

  it("Back returns to the gallery, and a pack previewed again starts with everything ticked", () => {
    toPreview();
    fireEvent.click(row(/^Studio routines/));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("dialog", { name: "Set up Acme" })).toBeInTheDocument();
    fireEvent.click(within(card("Boutique fitness group")).getByRole("button", { name: "Preview" }));
    expect(row(/^Studio routines/)).toBeChecked();
  });

  it("without packs, it's the team templates as before", () => {
    render(<NewWorkspaceModal open onClose={vi.fn()} onCreate={vi.fn()} />);
    named("Acme");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.queryByRole("list", { name: "Business packs" })).toBeNull();
    expect(screen.getByRole("list", { name: "Team templates" })).toBeInTheDocument();
  });
});

describe("the preview, for someone who can't set goals or the update day", () => {
  it("leaves the goals and the update day out, and says why", () => {
    const h = host({ context: context({ mode: "project", canSetGoals: false, canSetUpdateDay: false, updateDayNote: "Only owners and admins set the workspace's update day." }), apply: vi.fn(async () => null) });
    render(<NewProjectModal open onClose={vi.fn()} onCreate={vi.fn()} workspaceId="ws-1" onApplyTemplate={vi.fn(async () => {})} packs={h} />);
    fireEvent.click(screen.getByRole("button", { name: "From a pack or template" }));
    fireEvent.click(within(card("Padel or sports venue")).getByRole("button", { name: "Preview" }));
    expect(screen.getByText("Owners and admins set the business's goals, so these are left out.")).toBeInTheDocument();
    expect(row(/Busy courts at every hour/)).toBeDisabled();
    expect(row(/Busy courts at every hour/)).not.toBeChecked();
    expect(row(/Project updates every Monday/)).toBeDisabled();
    expect(row(/Project updates every Monday/)).toHaveAccessibleName(/Only owners and admins set the workspace's update day/);
    expect(screen.getByText("4 projects · 24 tasks · 1 portfolio · 4 docs · 1 form")).toBeInTheDocument();
  });

  it("before Goals 2.0, says the goals go in without owners and quarters", () => {
    const h = host({ context: context({ goalsV2: false }) });
    render(<NewWorkspaceModal open onClose={vi.fn()} onCreate={vi.fn()} packs={h} />);
    named("Acme");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(within(card("Startup")).getByRole("button", { name: "Preview" }));
    expect(screen.getByText(/Goal owners and quarters aren't switched on yet/)).toBeInTheDocument();
    expect(row(/^Customers love the product/)).toHaveAccessibleName(/^Customers love the product$/);
  });
});

describe("New project › From a pack or template", () => {
  it("previews a pack, sets it up in this workspace (the update day left alone unless ticked), and Done goes to Projects", async () => {
    const h = host({ context: context({ mode: "project" }) });
    h.apply = vi.fn((pack: WorkspaceTemplate, pick: PackPick) => outcomeOf(pack, pick, h.context));
    const onClose = vi.fn();
    render(<NewProjectModal open onClose={onClose} onCreate={vi.fn()} workspaceId="ws-1" onApplyTemplate={vi.fn(async () => {})} packs={h} />);
    fireEvent.click(screen.getByRole("button", { name: "From a pack or template" }));
    const gallery = screen.getByRole("dialog", { name: "Packs and templates" });
    expect(within(gallery).getByRole("list", { name: "Team templates" })).toBeInTheDocument();
    fireEvent.click(within(card("Advisory firm")).getByRole("button", { name: "Preview" }));
    expect(row(/Project updates every Friday.*whole workspace/)).not.toBeChecked();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Set up Advisory firm" })); });
    expect(h.apply).toHaveBeenCalledWith(findPack("pack-advisory"), expect.objectContaining({ off: [packPart.updates] }));
    expect(await screen.findByRole("heading", { name: "Advisory firm is set up" })).toBeInTheDocument();
    expect(screen.queryByText(/^Updates every/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalled();
    expect(h.open).toHaveBeenCalledWith({ view: "projects" });
  });

  it("a holding company names its businesses: each gets a project and a portfolio", async () => {
    const h = host({ context: context({ mode: "project", businesses: ["Courtside Padel", "Reco HQ"] }) });
    h.apply = vi.fn((pack: WorkspaceTemplate, pick: PackPick) => outcomeOf(pack, pick, h.context));
    render(<NewProjectModal open onClose={vi.fn()} onCreate={vi.fn()} workspaceId="ws-1" onApplyTemplate={vi.fn(async () => {})} packs={h} />);
    fireEvent.click(screen.getByRole("button", { name: "From a pack or template" }));
    fireEvent.click(within(card("Holding company")).getByRole("button", { name: "Preview" }));
    expect(screen.getByRole("textbox", { name: "Business 1" })).toHaveValue("Courtside Padel");
    fireEvent.click(screen.getByRole("button", { name: "Remove Reco HQ" }));
    fireEvent.click(screen.getByRole("button", { name: "Add a business" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Business 2" }), { target: { value: "North Gym" } });
    expect(screen.getByText("5 projects · 18 tasks · 3 goals · 2 portfolios · 3 docs")).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Set up Holding company" })); });
    expect(h.apply).toHaveBeenCalledWith(findPack("pack-holding"), expect.objectContaining({ businesses: ["Courtside Padel", "North Gym"] }));
    await waitFor(() => expect(screen.getByText("Courtside Padel, North Gym")).toBeInTheDocument());
  });

  it("without packs, it's the team template gallery as before", () => {
    render(<NewProjectModal open onClose={vi.fn()} onCreate={vi.fn()} workspaceId="ws-1" onApplyTemplate={vi.fn(async () => {})} />);
    fireEvent.click(screen.getByRole("button", { name: "From a team template" }));
    expect(screen.getByRole("dialog", { name: "From a team template" })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Business packs" })).toBeNull();
  });
});

describe("packContextFor", () => {
  const base = { goalsV2: true, rhythmOn: true, businesses: [], today: TODAY };
  it("a new workspace is yours to run: goals and the update day", () => {
    expect(packContextFor({ ...base, workspaceId: null, role: null, mode: "workspace" })).toMatchObject({ canSetGoals: true, canSetUpdateDay: true, updateDayNote: undefined });
  });
  it("in a team you're a member of: no business goals (since 0052) and no update day", () => {
    const c = packContextFor({ ...base, workspaceId: "ws-1", role: "member", mode: "project" });
    expect(c).toMatchObject({ canSetGoals: false, canSetUpdateDay: false, updateDayNote: "Only owners and admins set the workspace's update day." });
    expect(packContextFor({ ...base, goalsV2: false, workspaceId: "ws-1", role: "member", mode: "project" }).canSetGoals).toBe(true);
    expect(packContextFor({ ...base, workspaceId: "ws-1", role: "admin", mode: "project" })).toMatchObject({ canSetGoals: true, canSetUpdateDay: true });
  });
  it("Personal: your own goals, no update day; before 0053, no update day anywhere", () => {
    expect(packContextFor({ ...base, workspaceId: null, role: null, mode: "project" })).toMatchObject({ canSetGoals: true, canSetUpdateDay: false, updateDayNote: "Personal has no update day." });
    expect(packContextFor({ ...base, rhythmOn: false, workspaceId: "ws-1", role: "owner", mode: "project" })).toMatchObject({ canSetUpdateDay: false, updateDayNote: "Update days aren't switched on yet." });
  });
});

describe("keyResultTarget", () => {
  it("reads a target as people would say it", () => {
    expect(keyResultTarget({ target: 75, unit: "%" })).toBe("75%");
    expect(keyResultTarget({ target: 250000, unit: "£" })).toBe("£250,000");
    expect(keyResultTarget({ target: 150, unit: "members" })).toBe("150 members");
    expect(keyResultTarget({ target: 4, unit: "%", direction: "lower" })).toBe("4% or less");
    expect(keyResultTarget({ unit: "£" })).toBe("Target to set");
  });
  it("every pack's key results read cleanly", () => {
    for (const p of BUSINESS_PACKS) for (const g of p.goals ?? []) for (const k of g.keyResults ?? []) expect(keyResultTarget(k)).not.toMatch(/undefined|NaN/);
  });
});
