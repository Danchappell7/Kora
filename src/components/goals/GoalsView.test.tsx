/* Goals 2.0 on the Goals page: owners and quarters, who may change what (the same rules
   as 0052), a check-in, the pace line and the status it suggests (never set by itself),
   links, key results, archived goals, and the page as it was before 0052 is run. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { Goal, GoalCheckin, GoalExtras, GoalLink, Project, Task, WorkspaceMember } from "../../data/types";
import { GoalsView } from "./GoalsView";

const TODAY = new Date(2026, 10, 10);   // 10 Nov 2026: day 40 of Q4's 91, 44% of the way
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(2026, 10, 10, 12)); });
afterEach(() => { vi.useRealTimers(); });

const Q4 = { period: "2026-Q4", periodStart: "2026-10-01", periodEnd: "2026-12-31" };
const goal = (o: Partial<Goal> & { id: string; name: string }): Goal => ({ status: "on_track", workspaceId: "ws", ownerId: "m-self", contributors: [], kind: "objective", direction: "higher", visibility: "everyone", pace: "linear", ...Q4, ...o });
const member = (userId: string, name: string, role: WorkspaceMember["role"]): WorkspaceMember => ({ id: `wm-${userId}`, workspaceId: "ws", userId, email: `${userId}@x.org`, name, role, status: "active" });
const MEMBERS = [member("m-self", "Daniel Okai", "owner"), member("m-1", "Maya Lin", "member"), member("m-2", "Theo Vance", "member"), member("m-4", "Idris Bell", "guest")];
const PROJECTS: Project[] = [{ id: "p1", name: "Launch", emoji: "🚀", color: "red", workspaceId: "ws" }, { id: "p2", name: "Brand", emoji: "🎨", color: "blue", workspaceId: "ws" }];
const TASKS: Task[] = [{ id: "t1", title: "Write the plan", description: "", status: "todo", priority: "medium", projectId: "p1", assigneeId: "m-self", tags: [], dependencies: [], subtasks: [], focusMin: 30, comments: 0, aiScore: 0 }];
const NO_EXTRAS: GoalExtras = { checkins: [], links: [] };

function renderGoals(goals: Goal[], o: Partial<Parameters<typeof GoalsView>[0]> = {}) {
  const props = {
    goals, projects: PROJECTS, tasks: TASKS, onCreate: vi.fn(), onUpdate: vi.fn(), onDelete: vi.fn(),
    extras: NO_EXTRAS, workspaceId: "ws", me: "m-self", role: "owner" as const, members: MEMBERS, today: TODAY,
    onCheckin: vi.fn(), onDeleteCheckin: vi.fn(), onLink: vi.fn(), onUnlink: vi.fn(), ...o,
  };
  return { ...render(<GoalsView {...props} />), props };
}
const card = (name: string) => screen.getByRole("article", { name: `Goal ${name}` });
const meter = (name: string) => screen.getByRole("progressbar", { name: `${name} progress` });

describe("Goals 2.0: owners and quarters", () => {
  it("an owner picks a goal's owner from the workspace's members (never a guest) and its quarter", () => {
    const { props } = renderGoals([goal({ id: "g", name: "Grow", target: 100, current: 40 })]);
    const owner = screen.getByLabelText("Owner of Grow") as HTMLSelectElement;
    expect([...owner.options].map((o) => o.text)).toEqual(["No owner", "Daniel Okai", "Maya Lin", "Theo Vance"]);
    fireEvent.change(owner, { target: { value: "m-1" } });
    expect(props.onUpdate).toHaveBeenLastCalledWith("g", { ownerId: "m-1" });
    const period = screen.getByLabelText("Period of Grow") as HTMLSelectElement;
    expect(period.value).toBe("2026-Q4");
    fireEvent.change(period, { target: { value: "2027-Q1" } });
    expect(props.onUpdate).toHaveBeenLastCalledWith("g", { period: "2027-Q1", periodStart: "2027-01-01", periodEnd: "2027-03-31" });
    fireEvent.change(period, { target: { value: "" } });
    expect(props.onUpdate).toHaveBeenLastCalledWith("g", { period: null, periodStart: null, periodEnd: null });
  });

  it("a member edits the goals they own or help on; the rest they read, and company goals are for owners and admins", () => {
    renderGoals([
      goal({ id: "a", name: "Theirs", ownerId: "m-2", target: 10, current: 4, unit: "deals" }),
      goal({ id: "b", name: "Mine", ownerId: "m-1", target: 10, current: 2 }),
      goal({ id: "c", name: "Helping", ownerId: "m-2", contributors: ["m-1"], target: 10, current: 3 }),
    ], { me: "m-1", role: "member" });
    expect(within(card("Theirs")).queryAllByRole("combobox")).toHaveLength(0);
    expect(within(card("Theirs")).queryByRole("textbox")).toBeNull();
    expect(within(card("Theirs")).queryByRole("button", { name: /Delete goal/ })).toBeNull();
    expect(within(card("Theirs")).getByText("4 of 10 deals")).toBeInTheDocument();
    expect(within(card("Mine")).getByLabelText("Goal name: Mine")).toBeInTheDocument();
    expect(within(card("Mine")).getByLabelText("Owner of Mine")).toBeInTheDocument();   // the goal's owner hands it over
    // a contributor edits but doesn't hand it over
    expect(within(card("Helping")).getByLabelText("Status of Helping")).toBeInTheDocument();
    expect(within(card("Helping")).queryByLabelText("Owner of Helping")).toBeNull();
    expect(within(card("Helping")).getByText("Theo Vance")).toBeInTheDocument();
    // no New goal: owners and admins set the company's goals
    expect(screen.queryByRole("button", { name: "New goal" })).toBeNull();
    expect(screen.getByText(/Owners and admins set the business's goals/)).toBeInTheDocument();
  });

  it("a member adds a key result under a goal they own: theirs, in the same quarter", () => {
    const { props } = renderGoals([goal({ id: "b", name: "Mine", ownerId: "m-1", target: 10, current: 2 })], { me: "m-1", role: "member" });
    fireEvent.click(within(card("Mine")).getByRole("button", { name: "Add a key result" }));
    fireEvent.change(screen.getByLabelText("New key result under Mine"), { target: { value: "Ten demos booked" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(props.onCreate).toHaveBeenCalledWith("Ten demos booked", { parentId: "b", kind: "key_result", ownerId: "m-1", ...Q4 });
  });

  it("an owner's new goal is a company goal, theirs, this quarter", () => {
    const { props } = renderGoals([goal({ id: "g", name: "Grow" })]);
    fireEvent.click(screen.getByRole("button", { name: "New goal" }));
    fireEvent.change(screen.getByLabelText("New goal name"), { target: { value: "Hire two engineers" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(props.onCreate).toHaveBeenCalledWith("Hire two engineers", { kind: "objective", ownerId: "m-self", ...Q4 });
  });

  it("a leadership-only goal is for owners, admins and its own people", () => {
    const lead = goal({ id: "l", name: "Sell the company", ownerId: "m-self", visibility: "leadership", target: 1, current: 0 });
    const { unmount } = renderGoals([lead, goal({ id: "g", name: "Grow" })], { me: "m-1", role: "member" });
    expect(screen.queryByRole("article", { name: "Goal Sell the company" })).toBeNull();
    unmount();
    renderGoals([lead]);
    expect(within(card("Sell the company")).getByText("Leadership only")).toBeInTheDocument();
  });
});

describe("Goals 2.0: progress and pace", () => {
  it("cut churn from 8% to 5% reads 0% on day one", () => {
    renderGoals([goal({ id: "c", name: "Cut churn", direction: "lower", startValue: 8, target: 5, current: 8, unit: "%" })]);
    expect(meter("Cut churn")).toHaveAttribute("aria-valuenow", "0");
  });

  it("says how far behind pace a goal is and suggests a status the owner takes in one tap; it never sets one itself", () => {
    const { props } = renderGoals([goal({ id: "g", name: "Grow", target: 100, current: 32, status: "on_track" })]);
    const c = card("Grow");
    expect(within(c).getByText("Behind pace by 12%")).toBeInTheDocument();
    expect(within(c).getByText("Kanbo suggests At risk.")).toBeInTheDocument();
    expect(props.onUpdate).not.toHaveBeenCalled();
    fireEvent.click(within(c).getByRole("button", { name: "Mark At risk" }));
    expect(props.onUpdate).toHaveBeenCalledWith("g", { status: "at_risk" });
  });

  it("when the status already says what the pace says, it's just the line; a reader sees the suggestion with no button", () => {
    const { unmount } = renderGoals([goal({ id: "g", name: "Grow", target: 100, current: 32, status: "at_risk" })]);
    expect(screen.getByText("Behind pace by 12%")).toBeInTheDocument();
    expect(screen.queryByText(/Kanbo suggests/)).toBeNull();
    unmount();
    renderGoals([goal({ id: "g", name: "Grow", ownerId: "m-2", target: 100, current: 32 })], { me: "m-1", role: "member" });
    expect(screen.getByText("Kanbo suggests At risk.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Mark/ })).toBeNull();
  });

  it("a goal past its date unfinished suggests Off track; a back-loaded one expects little early; no pace line when it's off", () => {
    renderGoals([
      goal({ id: "late", name: "Late", target: 100, current: 60, due: "2026-11-01" }),
      goal({ id: "slow", name: "Slow start", target: 100, current: 20, pace: "backloaded" }),
      goal({ id: "none", name: "No pace", target: 100, current: 1, pace: "off" }),
    ]);
    expect(within(card("Late")).getByText("Past due at 60%")).toBeInTheDocument();
    expect(within(card("Late")).getByText("Kanbo suggests Off track.")).toBeInTheDocument();
    expect(within(card("Slow start")).getByText("On pace")).toBeInTheDocument();
    expect(card("No pace").querySelector(".kgl-pace")).toBeNull();
  });
});

describe("Goals 2.0: check-ins", () => {
  const checkins: GoalCheckin[] = [
    { id: "c2", goalId: "g", workspaceId: "ws", authorId: "m-1", value: 3760, confidence: 3, note: "Onboarding fix is in", createdAt: "2026-11-08T17:00:00Z" },
    { id: "c1", goalId: "g", workspaceId: "ws", authorId: null, value: 3550, confidence: null, createdAt: "2026-10-25T17:00:00Z" },
  ];
  it("shows the newest check-in and the history, a departed author as Former member", () => {
    renderGoals([goal({ id: "g", name: "Grow", startValue: 3200, target: 5000, current: 3760, unit: "users" })], { extras: { checkins, links: [] } });
    const c = card("Grow");
    expect(within(c).getByText("Checked in 2 days ago by Maya:")).toBeInTheDocument();
    expect(within(c).getByText("3,760 users", { selector: "b" })).toBeInTheDocument();
    expect(within(c).getByText("Onboarding fix is in")).toBeInTheDocument();
    fireEvent.click(within(c).getByRole("button", { name: "History (2)" }));
    const history = within(c).getByRole("list", { name: "Check-ins on Grow" });
    expect(within(history).getByText("Former member")).toBeInTheDocument();
    fireEvent.click(within(history).getByRole("button", { name: "Take back the check-in of 3,550 users" }));
  });

  it("posts one: a number, how sure you are and a note", () => {
    const { props } = renderGoals([goal({ id: "g", name: "Grow", target: 5000, current: 3760 })]);
    fireEvent.click(within(card("Grow")).getByRole("button", { name: "Check in" }));
    const box = within(card("Grow")).getByRole("group", { name: "Check in on Grow" });
    fireEvent.change(within(box).getByLabelText("Where it stands"), { target: { value: "3900" } });
    fireEvent.change(within(box).getByLabelText("Confidence"), { target: { value: "4" } });
    fireEvent.change(within(box).getByLabelText("Note"), { target: { value: "Referral pilot live" } });
    fireEvent.click(within(box).getByRole("button", { name: "Post check-in" }));
    expect(props.onCheckin).toHaveBeenCalledWith(expect.objectContaining({ id: "g" }), 3900, 4, "Referral pilot live");
    expect(within(card("Grow")).queryByRole("group", { name: "Check in on Grow" })).toBeNull();
  });

  it("only goals that track their own number take check-ins, and only from people who may edit them", () => {
    renderGoals([
      goal({ id: "p", name: "From a project", projectId: "p1" }),
      goal({ id: "t", name: "Theirs", ownerId: "m-2", target: 10, current: 2 }),
    ], { me: "m-1", role: "member" });
    expect(screen.queryByRole("button", { name: "Check in" })).toBeNull();
  });
});

describe("Goals 2.0: linked work", () => {
  it("lists the goal's projects and tasks; editors link more and unlink", () => {
    const links: GoalLink[] = [
      { id: "l1", goalId: "g", workspaceId: "ws", kind: "project", targetId: "p1" },
      { id: "l2", goalId: "g", workspaceId: "ws", kind: "task", targetId: "t1" },
    ];
    const { props } = renderGoals([goal({ id: "g", name: "Grow", target: 10, current: 1 })], { extras: { checkins: [], links } });
    const c = within(card("Grow")).getByLabelText("Work linked to Grow");
    expect(within(c).getByText("Launch")).toBeInTheDocument();
    expect(within(c).getByText("Write the plan")).toBeInTheDocument();
    fireEvent.click(within(c).getByRole("button", { name: "Unlink Write the plan" }));
    expect(props.onUnlink).toHaveBeenCalledWith(links[1]);
    const pick = within(c).getByLabelText("Link work to Grow") as HTMLSelectElement;
    expect([...pick.options].map((o) => o.value)).toEqual(["", "project:p2"]);   // the task's already linked; Launch too
    fireEvent.change(pick, { target: { value: "project:p2" } });
    expect(props.onLink).toHaveBeenCalledWith(expect.objectContaining({ id: "g" }), "project", "p2");
  });
});

describe("Goals 2.0: archived goals", () => {
  it("are out of the way until asked for, and come back with Restore", () => {
    const { props } = renderGoals([goal({ id: "g", name: "Grow" }), goal({ id: "old", name: "Last quarter's", archivedAt: "2026-10-01T09:00:00Z" })]);
    expect(screen.queryByRole("article", { name: "Goal Last quarter's" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show archived (1)" }));
    fireEvent.click(within(card("Last quarter's")).getByRole("button", { name: "Restore goal Last quarter's" }));
    expect(props.onUpdate).toHaveBeenCalledWith("old", { archivedAt: null });
    fireEvent.click(within(card("Grow")).getByRole("button", { name: "Archive goal Grow" }));
    expect(props.onUpdate).toHaveBeenLastCalledWith("g", { archivedAt: expect.any(String) });
  });
});

describe("before 0052 is run", () => {
  it("is the page it always was (anyone who writes edits; no owners, quarters or check-ins), with the pace line from when the goal was made", () => {
    renderGoals([{ id: "g", name: "Grow", status: "on_track", workspaceId: "ws", target: 100, current: 10, createdAt: "2026-10-01T09:00:00Z", due: "2026-12-31" }],
      { extras: null, me: "m-1", role: "member" });
    expect(screen.getByLabelText("Goal name: Grow")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New goal" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Owner of Grow")).toBeNull();
    expect(screen.queryByLabelText("Period of Grow")).toBeNull();
    expect(screen.queryByRole("button", { name: "Check in" })).toBeNull();
    expect(screen.getByText("Behind pace by 34%")).toBeInTheDocument();
  });
});
